#!/usr/bin/env python3
"""
Phase B ETL v3: orjson + multiprocess workers for the per-source JSON writes.

Previous attempts ran ~4 files/sec because the Python json + gzip step on
2×37k-key dicts is CPU-bound. With orjson (~5x faster than stdlib json) and
a process pool consuming sources from a queue, throughput scales linearly
with cores. Target: ~40-80 files/sec → 8-15 min total.
"""
import duckdb, gzip, json, heapq, time, multiprocessing as mp, os, signal
from pathlib import Path

try:
    import orjson
    _orjson_dumps = orjson.dumps
except ImportError:
    _orjson_dumps = None

SHARD_GLOB  = "/tmp/sci-v3/shards/gadm2_shard_*.csv"
OUT_DIR     = Path("/tmp/sci-v3/out_v2")
TEMP_DIR    = Path("/tmp/sci-v3/duckdb_temp")
TOP_N       = 20
USER_THRESH = [1.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0]
N_WORKERS   = 6  # leave 2 cores for DuckDB

OUT_DIR.mkdir(parents=True, exist_ok=True)
TEMP_DIR.mkdir(parents=True, exist_ok=True)

def log(m):
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)

# ----- worker -----
def _worker(in_q, out_q):
    # Each task is (src, ref, a_dict, b_dict, top_list)
    import gzip, orjson
    from pathlib import Path
    out_dir = Path("/tmp/sci-v3/out_v2")
    written = 0
    while True:
        task = in_q.get()
        if task is None:
            out_q.put(written)
            return
        src, ref, a, b, top = task
        payload = {"ref": ref, "a": a, "b": b, "top": top}
        data = orjson.dumps(payload)
        with gzip.open(out_dir / f"{src}.json.gz", "wb", compresslevel=6) as f:
            f.write(data)
        written += 1

# ----- main -----
def main():
    meta_path = OUT_DIR / "_meta.json"
    if not meta_path.exists():
        raise SystemExit("missing _meta.json")
    META = json.loads(meta_path.read_text())
    QUANTILES = META["thresholds_b"]
    log(f"reusing thresholds: A={USER_THRESH}, B={QUANTILES}")

    con = duckdb.connect(database=':memory:')
    con.execute("SET memory_limit = '8GB'")
    con.execute(f"SET temp_directory = '{TEMP_DIR}'")
    con.execute("SET threads = 8")
    con.execute("PRAGMA disable_progress_bar")

    log("registering shard view + ref table")
    con.execute(f"""
    CREATE VIEW sci AS
    SELECT user_region, friend_region, scaled_sci::DOUBLE AS scaled_sci
    FROM read_csv('{SHARD_GLOB}',
                  header=true,
                  columns={{'user_country':'VARCHAR','friend_country':'VARCHAR',
                            'user_region':'VARCHAR','friend_region':'VARCHAR',
                            'scaled_sci':'BIGINT'}})
    """)
    con.execute("""
    CREATE TABLE ref AS
    SELECT user_region, quantile_cont(scaled_sci, 0.2) AS ref_sci
    FROM sci
    WHERE user_region <> friend_region
    GROUP BY user_region
    """)
    log("  ref table built (37k rows)")

    def case_for(thresholds):
        parts = " ".join(f"WHEN ratio < {t} THEN {i}" for i, t in enumerate(thresholds))
        return f"CASE {parts} ELSE {len(thresholds)} END"

    case_a = case_for(USER_THRESH)
    case_b = case_for(QUANTILES)

    # Spin up worker pool
    in_q = mp.Queue(maxsize=N_WORKERS * 4)
    out_q = mp.Queue()
    workers = []
    for _ in range(N_WORKERS):
        p = mp.Process(target=_worker, args=(in_q, out_q))
        p.start()
        workers.append(p)
    log(f"started {N_WORKERS} writer workers")

    log("running ORDER BY user_region stream query")
    cur = con.execute(f"""
    WITH pairs AS (
      SELECT s.user_region, s.friend_region, s.scaled_sci::BIGINT AS scaled_sci,
             r.ref_sci::BIGINT AS ref_sci,
             (s.scaled_sci / NULLIF(r.ref_sci, 0))::DOUBLE AS ratio
      FROM sci s JOIN ref r ON r.user_region = s.user_region
      WHERE r.ref_sci > 0
    )
    SELECT user_region, friend_region, scaled_sci, ref_sci,
           CAST({case_a} AS UTINYINT) AS bin_a,
           CAST({case_b} AS UTINYINT) AS bin_b
    FROM pairs
    ORDER BY user_region
    """)

    current_src = None
    current_a = {}
    current_b = {}
    current_top = []
    current_ref = 0
    queued = 0
    t0 = time.time()

    def emit():
        nonlocal queued
        if current_src is None: return
        if current_src in ("?", ""): return
        current_top.sort(key=lambda r: -r[0])
        top_payload = [{"g": fr, "s": int(sci), "a": int(ba), "b": int(bb)}
                       for sci, fr, ba, bb in current_top]
        in_q.put((current_src, int(current_ref), current_a, current_b, top_payload))
        queued += 1
        if queued % 2000 == 0:
            rate = queued / max(time.time() - t0, 0.001)
            log(f"  queued {queued:,} sources ({rate:.0f}/s)")

    log("streaming rows")
    while True:
        rows = cur.fetchmany(500_000)
        if not rows: break
        for src, fr, sci, ref, ba, bb in rows:
            if src != current_src:
                emit()
                current_src = src
                current_a = {}
                current_b = {}
                current_top = []
                current_ref = ref
            current_a[fr] = int(ba)
            current_b[fr] = int(bb)
            if fr != src:
                entry = (sci, fr, ba, bb)
                if len(current_top) < TOP_N:
                    heapq.heappush(current_top, entry)
                elif sci > current_top[0][0]:
                    heapq.heapreplace(current_top, entry)
    emit()
    log(f"queued {queued:,} sources; draining workers")
    for _ in workers:
        in_q.put(None)
    total = 0
    for w in workers:
        w.join()
    while not out_q.empty():
        total += out_q.get_nowait()
    log(f"DONE: wrote {total:,} per-source JSONs in {(time.time()-t0):.0f}s")

if __name__ == "__main__":
    if _orjson_dumps is None:
        raise SystemExit("orjson not available; pip3 install --user orjson")
    main()

import sqlite3
import unittest
from pathlib import Path
from verify_revisions import record, reconcile


class LocalDB:
    def __init__(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript((Path(__file__).resolve().parents[1] / "db/schema.sql").read_text())

    def query(self, sql, params=()):
        return self.conn.execute(sql, params).fetchall()


class RevisionTest(unittest.TestCase):
    def test_early_candidate_and_historical_reuse(self):
        db = LocalDB()
        db.query("""INSERT INTO papers(id,year,num,title,authors,updated,pdf_key,pdf_sha256)
                    VALUES('p',2026,1,'Paper','[]','A','first','a')""")
        db.query("""INSERT INTO uploads(id,paper_id,r2_key,sha256,size,created_at,status)
                    VALUES('candidate','p','second','b',100,'today','candidate')""")
        record(db, 'p', 'B', 'b')
        reconcile(db)
        current = lambda: db.query("SELECT pdf_sha256 FROM papers")[0][0]
        self.assertEqual(current(), 'a')
        db.query("UPDATE papers SET updated='B'")
        reconcile(db)
        self.assertEqual(current(), 'b')
        db.query("UPDATE papers SET pdf_key='render',pdf_sha256='different',pdf_maybe_stale=1")
        reconcile(db)
        self.assertEqual(current(), 'b')
        db.query("UPDATE papers SET updated='C',pdf_maybe_stale=1")
        reconcile(db)
        self.assertEqual(db.query("SELECT pdf_maybe_stale FROM papers")[0][0], 1)
        self.assertEqual(db.query("SELECT count(*) FROM versions")[0][0], 1)


if __name__ == '__main__':
    unittest.main()

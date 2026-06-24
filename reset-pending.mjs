import Database from 'better-sqlite3';
const db = new Database('./data/assumed_names.db');
const before = db.prepare("SELECT COUNT(*) n FROM filings WHERE retry_count>0 OR last_checked IS NOT NULL").get().n;
db.prepare("UPDATE filings SET retry_count=0, last_checked=NULL WHERE image_status NOT IN ('extracted','dead')").run();
console.log('reset rows that had retry/last_checked:', before);
console.log('status now:', db.prepare("SELECT image_status, COUNT(*) n FROM filings GROUP BY image_status").all());
db.close();

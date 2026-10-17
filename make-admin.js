const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const [name, flag] = process.argv.slice(2);
if (!name) { console.log('用法：node make-admin.js 用户名 [off]'); process.exit(1); }
const db = new DatabaseSync(path.join(__dirname, 'data.db'));
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
const u = db.prepare('SELECT id FROM users WHERE name=?').get(name);
if (!u) { console.log('找不到用户：' + name); process.exit(1); }
db.prepare('UPDATE users SET is_admin=? WHERE id=?').run(flag === 'off' ? 0 : 1, u.id);
console.log(name + (flag === 'off' ? ' 已取消管理员身份。' : ' 已设为管理员，请让对方刷新网页后生效。'));

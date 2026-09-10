// ============================================================
//  FITNESS & GYM CRM — REST API
//  Клиенты • Бар • Аналитика
//  Все эндпоинты защищены HMAC-валидацией через authMiddleware
// ============================================================

const { getDb } = require('./db');

// ------------------------------------------------------------
// Хелперы
// ------------------------------------------------------------
function ok(res, payload) {
  res.json({ ok: true, ...payload });
}

function fail(res, status, code) {
  res.status(status).json({ ok: false, error: code });
}

// Парсинг диапазона дат из query
function parseRange(query) {
  let from = query.from ? new Date(query.from) : new Date();
  let to   = query.to   ? new Date(query.to)   : new Date();
  if (isNaN(from.getTime())) from = new Date();
  if (isNaN(to.getTime()))   to   = new Date();
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

// Валидация строки (защита от мусора в БД)
function str(v, maxLen = 200) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > maxLen) return null;
  return s;
}

// Валидация числа
function num(v, min = -1e9, max = 1e9) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

// ------------------------------------------------------------
// Регистрация всех маршрутов
// ------------------------------------------------------------
function registerRoutes(app, authMiddleware) {

  // ═══════════════════════════════════════════════════════════
  //  КЛИЕНТЫ
  // ═══════════════════════════════════════════════════════════

  // GET /api/members?q=&limit=
  app.get('/api/members', authMiddleware, (req, res) => {
    const db = getDb();
    const q = str(req.query.q, 100) || '';
    const limit = Math.min(Math.max(num(req.query.limit, 1, 200) || 100, 1), 200);

    const rows = q
      ? db.prepare(`
          SELECT * FROM members
          WHERE full_name LIKE ? OR phone LIKE ?
          ORDER BY membership_ends_at ASC NULLS FIRST
          LIMIT ?
        `).all(`%${q}%`, `%${q}%`, limit)
      : db.prepare(`
          SELECT * FROM members
          ORDER BY membership_ends_at ASC NULLS FIRST
          LIMIT ?
        `).all(limit);

    const ts = Date.now();
    const items = rows.map(m => {
      const endTs = m.membership_ends_at ? new Date(m.membership_ends_at).getTime() : 0;
      const daysLeft = endTs ? Math.ceil((endTs - ts) / 86400000) : -9999;
      let flag = 'OK';
      if (!endTs || daysLeft < 0)      flag = 'EXPIRED';
      else if (daysLeft < 3)           flag = 'WARNING';

      return {
        id: m.id,
        fullName: m.full_name,
        phone: m.phone,
        membershipEndsAt: m.membership_ends_at,
        deposit: m.deposit,
        daysLeft,
        flag,
      };
    });

    ok(res, { items });
  });

  // GET /api/members/:id
  app.get('/api/members/:id', authMiddleware, (req, res) => {
    const db = getDb();
    const id = num(req.params.id, 1);
    if (!id) return fail(res, 400, 'INVALID_ID');

    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!m) return fail(res, 404, 'NOT_FOUND');

    const payments = db.prepare(
      'SELECT * FROM payments WHERE member_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(id);

    const deposits = db.prepare(
      'SELECT * FROM deposits WHERE member_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(id);

    const sales = db.prepare(`
      SELECT s.*, i.name AS item_name
      FROM bar_sales s
      JOIN bar_items i ON i.id = s.item_id
      WHERE s.member_id = ?
      ORDER BY s.created_at DESC LIMIT 50
    `).all(id);

    ok(res, {
      member: {
        id: m.id,
        fullName: m.full_name,
        phone: m.phone,
        membershipEndsAt: m.membership_ends_at,
        deposit: m.deposit,
        notes: m.notes,
      },
      payments,
      deposits,
      sales,
    });
  });

  // POST /api/members
  app.post('/api/members', authMiddleware, (req, res) => {
    const fullName = str(req.body?.fullName, 100);
    const phone    = str(req.body?.phone, 30);
    const notes    = str(req.body?.notes, 500);

    if (!fullName) return fail(res, 400, 'FULL_NAME_REQUIRED');

    const db = getDb();
    const info = db.prepare(
      'INSERT INTO members (full_name, phone, notes) VALUES (?, ?, ?)'
    ).run(fullName, phone, notes);

    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid);
    ok(res, { member });
  });

  // PATCH /api/members/:id
  app.patch('/api/members/:id', authMiddleware, (req, res) => {
    const id = num(req.params.id, 1);
    if (!id) return fail(res, 400, 'INVALID_ID');

    const db = getDb();
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!m) return fail(res, 404, 'NOT_FOUND');

    const fullName = str(req.body?.fullName, 100) || m.full_name;
    const phone    = req.body?.phone !== undefined ? str(req.body.phone, 30) : m.phone;
    const notes    = req.body?.notes !== undefined ? str(req.body.notes, 500) : m.notes;

    db.prepare(
      "UPDATE members SET full_name = ?, phone = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(fullName, phone, notes, id);

    const updated = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    ok(res, { member: updated });
  });

  // DELETE /api/members/:id — удаление клиента со всей историей
  app.delete('/api/members/:id', authMiddleware, (req, res) => {
    const id = num(req.params.id, 1);
    if (!id) return fail(res, 400, 'INVALID_ID');

    const db = getDb();
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!m) return fail(res, 404, 'NOT_FOUND');

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM payments WHERE member_id = ?').run(id);
      db.prepare('DELETE FROM deposits WHERE member_id = ?').run(id);
      db.prepare('UPDATE bar_sales SET member_id = NULL WHERE member_id = ?').run(id);
      db.prepare('DELETE FROM members WHERE id = ?').run(id);
    });
    tx();

    ok(res, { deleted: id });
  });

  // POST /api/members/:id/extend — продление абонемента
  app.post('/api/members/:id/extend', authMiddleware, (req, res) => {
    const id = num(req.params.id, 1);
    if (!id) return fail(res, 400, 'INVALID_ID');

    const days   = num(req.body?.days, 1, 3650);
    const amount = num(req.body?.amount, 0, 1e8);
    const method = ['CASH', 'CARD', 'DEPOSIT'].includes(req.body?.method) ? req.body.method : 'CASH';

    if (!days)   return fail(res, 400, 'INVALID_DAYS');
    if (amount === null) return fail(res, 400, 'INVALID_AMOUNT');

    const db = getDb();
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!m) return fail(res, 404, 'NOT_FOUND');

    if (method === 'DEPOSIT' && m.deposit < amount) {
      return fail(res, 400, 'INSUFFICIENT_FUNDS');
    }

    const nowDate = new Date();
    const base = m.membership_ends_at && new Date(m.membership_ends_at) > nowDate
      ? new Date(m.membership_ends_at)
      : nowDate;
    base.setDate(base.getDate() + days);
    const endsAt = base.toISOString();

    const tx = db.transaction(() => {
      db.prepare(
        "UPDATE members SET membership_ends_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
      ).run(endsAt, id);

      db.prepare(
        'INSERT INTO payments (member_id, admin_id, days, amount, method) VALUES (?, ?, ?, ?, ?)'
      ).run(id, req.admin.id, days, amount, method);

      if (method === 'DEPOSIT') {
        const newBalance = m.deposit - amount;
        db.prepare('UPDATE members SET deposit = ? WHERE id = ?').run(newBalance, id);
        db.prepare(
          'INSERT INTO deposits (member_id, admin_id, amount, type, note, balance_after) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, req.admin.id, -amount, 'PURCHASE', `Продление +${days} дн.`, newBalance);
      }
    });
    tx();

    const updated = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    ok(res, { member: updated });
  });

  // POST /api/members/:id/deposit — пополнение/списание
  app.post('/api/members/:id/deposit', authMiddleware, (req, res) => {
    const id = num(req.params.id, 1);
    if (!id) return fail(res, 400, 'INVALID_ID');

    const amount = Math.abs(num(req.body?.amount, 0.01, 1e8));
    const type = req.body?.type === 'WITHDRAW' ? 'WITHDRAW' : 'TOPUP';
    const note = str(req.body?.note, 200);

    if (!amount) return fail(res, 400, 'INVALID_AMOUNT');

    const db = getDb();
    const m = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    if (!m) return fail(res, 404, 'NOT_FOUND');

    const delta = type === 'TOPUP' ? amount : -amount;
    const newBalance = m.deposit + delta;
    if (newBalance < 0) return fail(res, 400, 'INSUFFICIENT_FUNDS');

    const tx = db.transaction(() => {
      db.prepare(
        "UPDATE members SET deposit = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
      ).run(newBalance, id);

      db.prepare(
        'INSERT INTO deposits (member_id, admin_id, amount, type, note, balance_after) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, req.admin.id, delta, type, note, newBalance);
    });
    tx();

    const updated = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    ok(res, { member: updated });
  });

  // ═══════════════════════════════════════════════════════════
  //  БАР
  // ═══════════════════════════════════════════════════════════

  // GET /api/bar/items?q=
  app.get('/api/bar/items', authMiddleware, (req, res) => {
    const db = getDb();
    const q = str(req.query.q, 100) || '';
    const items = q
      ? db.prepare('SELECT * FROM bar_items WHERE name LIKE ? ORDER BY category, name').all(`%${q}%`)
      : db.prepare('SELECT * FROM bar_items ORDER BY category, name').all();
    ok(res, { items });
  });

  // POST /api/bar/items
  app.post('/api/bar/items', authMiddleware, (req, res) => {
    const name = str(req.body?.name, 100);
    const category = str(req.body?.category, 40) || 'DRINKS';
    const price = num(req.body?.price, 0, 1e8);
    const cost  = num(req.body?.cost,  0, 1e8) ?? 0;
    const stock = Math.round(num(req.body?.stock, 0, 1e6) ?? 0);
    const minStock = Math.round(num(req.body?.minStock, 0, 1e6) ?? 3);

    if (!name) return fail(res, 400, 'NAME_REQUIRED');
    if (price === null || price <= 0) return fail(res, 400, 'INVALID_PRICE');

    const db = getDb();
    const info = db.prepare(
      'INSERT INTO bar_items (name, category, price, cost, stock, min_stock) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, category, price, cost, stock, minStock);

    const item = db.prepare('SELECT * FROM bar_items WHERE id = ?').get(info.lastInsertRowid);
    ok(res, { item });
  });

  // PATCH /api/bar/items/:id — изменить название/цены/категорию/мин. остаток
  app.patch('/api/bar/items/:id', authMiddleware, (req, res) => {
    const id = num(req.params.id, 1);
    if (!id) return fail(res, 400, 'INVALID_ID');

    const db = getDb();
    const item = db.prepare('SELECT * FROM bar_items WHERE id = ?').get(id);
    if (!item) return fail(res, 404, 'NOT_FOUND');

    const name = str(req.body?.name, 100) || item.name;
    const category = str(req.body?.category, 40) || item.category;
    const price = req.body?.price !== undefined ? num(req.body.price, 0.01, 1e8) : item.price;
    const cost  = req.body?.cost  !== undefined ? num(req.body.cost,  0, 1e8)   : item.cost;
    const minStock = req.body?.minStock !== undefined ? Math.round(num(req.body.minStock, 0, 1e6)) : item.min_stock;

    if (price === null || price <= 0) return fail(res, 400, 'INVALID_PRICE');
    if (cost === null) return fail(res, 400, 'INVALID_COST');
    if (minStock === null) return fail(res, 400, 'INVALID_MIN_STOCK');

    db.prepare(
      'UPDATE bar_items SET name = ?, category = ?, price = ?, cost = ?, min_stock = ? WHERE id = ?'
    ).run(name, category, price, cost, minStock, id);

    const updated = db.prepare('SELECT * FROM bar_items WHERE id = ?').get(id);
    ok(res, { item: updated });
  });

  // PATCH /api/bar/items/:id/stock — изменить остаток (delta или absolute)
  app.patch('/api/bar/items/:id/stock', authMiddleware, (req, res) => {
    const id = num(req.params.id, 1);
    if (!id) return fail(res, 400, 'INVALID_ID');

    const db = getDb();
    const item = db.prepare('SELECT * FROM bar_items WHERE id = ?').get(id);
    if (!item) return fail(res, 404, 'NOT_FOUND');

    let newStock;
    if (req.body?.absolute !== undefined) {
      newStock = Math.round(num(req.body.absolute, 0, 1e6));
    } else if (req.body?.delta !== undefined) {
      const delta = Math.round(num(req.body.delta, -1e6, 1e6));
      newStock = item.stock + delta;
    } else {
      return fail(res, 400, 'INVALID_UPDATE');
    }

    if (newStock === null || newStock < 0) {
      return fail(res, 400, 'NEGATIVE_STOCK');
    }

    db.prepare('UPDATE bar_items SET stock = ? WHERE id = ?').run(newStock, id);
    const updated = db.prepare('SELECT * FROM bar_items WHERE id = ?').get(id);
    ok(res, { item: updated });
  });

  // DELETE /api/bar/items/:id
  app.delete('/api/bar/items/:id', authMiddleware, (req, res) => {
    const id = num(req.params.id, 1);
    if (!id) return fail(res, 400, 'INVALID_ID');

    const db = getDb();
    const item = db.prepare('SELECT * FROM bar_items WHERE id = ?').get(id);
    if (!item) return fail(res, 404, 'NOT_FOUND');

    db.prepare('DELETE FROM bar_items WHERE id = ?').run(id);
    ok(res, { deleted: id });
  });

  // POST /api/bar/sales — продажа
  app.post('/api/bar/sales', authMiddleware, (req, res) => {
    const itemId = num(req.body?.itemId, 1);
    const quantity = Math.round(num(req.body?.quantity, 1, 1000) || 1);
    const memberId = req.body?.memberId ? num(req.body.memberId, 1) : null;
    const paymentMethod = ['CASH', 'CARD', 'DEPOSIT'].includes(req.body?.paymentMethod)
      ? req.body.paymentMethod : 'CASH';

    if (!itemId) return fail(res, 400, 'ITEM_REQUIRED');

    const db = getDb();
    const item = db.prepare('SELECT * FROM bar_items WHERE id = ?').get(itemId);
    if (!item) return fail(res, 404, 'ITEM_NOT_FOUND');
    if (item.stock < quantity) return fail(res, 400, 'OUT_OF_STOCK');

    const total = item.price * quantity;

    try {
      const tx = db.transaction(() => {
        if (paymentMethod === 'DEPOSIT') {
          if (!memberId) throw Object.assign(new Error('MEMBER_REQUIRED'), { status: 400 });
          const m = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
          if (!m) throw Object.assign(new Error('MEMBER_NOT_FOUND'), { status: 404 });
          if (m.deposit < total) throw Object.assign(new Error('INSUFFICIENT_FUNDS'), { status: 400 });

          const nb = m.deposit - total;
          db.prepare('UPDATE members SET deposit = ? WHERE id = ?').run(nb, m.id);
          db.prepare(
            'INSERT INTO deposits (member_id, admin_id, amount, type, note, balance_after) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(m.id, req.admin.id, -total, 'PURCHASE', `Бар: ${item.name} ×${quantity}`, nb);
        }

        db.prepare('UPDATE bar_items SET stock = stock - ? WHERE id = ?').run(quantity, itemId);

        const info = db.prepare(
          'INSERT INTO bar_sales (item_id, member_id, admin_id, quantity, unit_price, total, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(itemId, memberId, req.admin.id, quantity, item.price, total, paymentMethod);

        return info.lastInsertRowid;
      });

      const saleId = tx();
      ok(res, { saleId, total });
    } catch (e) {
      res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  АНАЛИТИКА
  // ═══════════════════════════════════════════════════════════

  // GET /api/analytics/summary?from=&to=
  app.get('/api/analytics/summary', authMiddleware, (req, res) => {
    const { from, to } = parseRange(req.query);
    const db = getDb();

    const payments = db.prepare(
      'SELECT amount FROM payments WHERE created_at >= ? AND created_at <= ?'
    ).all(from, to);

    const sales = db.prepare(
      'SELECT total, quantity FROM bar_sales WHERE created_at >= ? AND created_at <= ?'
    ).all(from, to);

    const topups = db.prepare(
      "SELECT amount FROM deposits WHERE type = 'TOPUP' AND created_at >= ? AND created_at <= ?"
    ).all(from, to);

    const memRevenue = payments.reduce((s, p) => s + p.amount, 0);
    const barRevenue = sales.reduce((s, x) => s + x.total, 0);
    const topupSum   = topups.reduce((s, d) => s + d.amount, 0);
    const barQty     = sales.reduce((s, x) => s + x.quantity, 0);

    const membersCount  = db.prepare('SELECT COUNT(*) AS c FROM members').get().c;
    const lowStockCount = db.prepare('SELECT COUNT(*) AS c FROM bar_items WHERE stock <= min_stock').get().c;

    ok(res, {
      from, to,
      totals: {
        revenue: memRevenue + barRevenue,
        membershipRevenue: memRevenue,
        barRevenue,
        topupSum,
        barQty,
        paymentsCount: payments.length,
        salesCount: sales.length,
        membersCount,
        lowStockCount,
      },
    });
  });

  // GET /api/analytics/charts?from=&to=
  app.get('/api/analytics/charts', authMiddleware, (req, res) => {
    const { from, to } = parseRange(req.query);
    const db = getDb();

    const payments = db.prepare(
      'SELECT amount, created_at FROM payments WHERE created_at >= ? AND created_at <= ?'
    ).all(from, to);

    const sales = db.prepare(
      'SELECT total, created_at FROM bar_sales WHERE created_at >= ? AND created_at <= ?'
    ).all(from, to);

    const dayKey = iso => new Date(iso).toISOString().slice(0, 10);

    const days = [];
    const cur = new Date(from);
    cur.setHours(0, 0, 0, 0);
    const end = new Date(to);
    let safety = 0;
    while (cur <= end && safety < 400) {
      days.push(dayKey(cur));
      cur.setDate(cur.getDate() + 1);
      safety++;
    }

    const map = Object.fromEntries(
      days.map(d => [d, { date: d, membership: 0, bar: 0, total: 0 }])
    );

    payments.forEach(p => {
      const k = dayKey(p.created_at);
      if (map[k]) { map[k].membership += p.amount; map[k].total += p.amount; }
    });
    sales.forEach(s => {
      const k = dayKey(s.created_at);
      if (map[k]) { map[k].bar += s.total; map[k].total += s.total; }
    });

    ok(res, { series: days.map(d => map[d]) });
  });

  // GET /api/analytics/recent — лента последних операций
  app.get('/api/analytics/recent', authMiddleware, (_req, res) => {
    const db = getDb();

    const payments = db.prepare(`
      SELECT p.*, m.full_name FROM payments p
      JOIN members m ON m.id = p.member_id
      ORDER BY p.created_at DESC LIMIT 15
    `).all();

    const sales = db.prepare(`
      SELECT s.*, i.name AS item_name, m.full_name
      FROM bar_sales s
      JOIN bar_items i ON i.id = s.item_id
      LEFT JOIN members m ON m.id = s.member_id
      ORDER BY s.created_at DESC LIMIT 15
    `).all();

    const deposits = db.prepare(`
      SELECT d.*, m.full_name FROM deposits d
      JOIN members m ON m.id = d.member_id
      ORDER BY d.created_at DESC LIMIT 15
    `).all();

    const feed = [
      ...payments.map(p => ({
        id: 'p' + p.id, kind: 'MEMBERSHIP', at: p.created_at,
        title: p.full_name, subtitle: `+${p.days} дн.`, amount: p.amount,
      })),
      ...sales.map(s => ({
        id: 's' + s.id, kind: 'BAR', at: s.created_at,
        title: s.item_name, subtitle: `${s.full_name || 'Гость'} · ×${s.quantity}`, amount: s.total,
      })),
      ...deposits.map(d => ({
        id: 'd' + d.id, kind: 'DEPOSIT', at: d.created_at,
        title: d.full_name, subtitle: d.type, amount: d.amount,
      })),
    ]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 30);

    ok(res, { feed });
  });
}

module.exports = { registerRoutes };
// Vérifie qu'une implémentation respecte SPEC.md.
// Usage : node contract-test.mjs http://localhost:8081
const base = process.argv[2] ?? 'http://localhost:8080';
let failures = 0;

async function call(method, path, body, raw) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, type: res.headers.get('content-type') ?? '', json, text };
}

function check(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ' -> ' + detail : ''}`); }
}

const sameKeys = (o, keys) => o && typeof o === 'object' && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());
const PRODUCT_KEYS = ['id', 'sku', 'name', 'quantity', 'price_cents'];

let r = await call('GET', '/health');
check('health 200', r.status === 200 && r.json?.status === 'ok', r.text);
check('health content-type json', r.type.includes('application/json'), r.type);

r = await call('GET', '/products/1');
check('get product 1', r.status === 200 && sameKeys(r.json, PRODUCT_KEYS) && r.json.id === 1 && r.json.sku === 'SKU-000001' && typeof r.json.price_cents === 'number', r.text);
check('product content-type json', r.type.includes('application/json'), r.type);

r = await call('GET', '/products/99999999');
check('get missing product 404', r.status === 404 && r.json?.error === 'not_found', r.text);
r = await call('GET', '/products/abc');
check('get invalid id 400', r.status === 400 && r.json?.error === 'invalid_input', r.text);
r = await call('GET', '/products/0');
check('get id 0 400', r.status === 400 && r.json?.error === 'invalid_input', r.text);

r = await call('GET', '/products');
check('list default 50', r.status === 200 && Array.isArray(r.json) && r.json.length === 50 && r.json[0].id === 1, r.text.slice(0, 200));
r = await call('GET', '/products?limit=10&offset=5');
check('list limit/offset', r.status === 200 && r.json?.length === 10 && r.json[0].id === 6 && sameKeys(r.json[0], PRODUCT_KEYS), r.text.slice(0, 200));
r = await call('GET', '/products?limit=101');
check('list limit 101 400', r.status === 400 && r.json?.error === 'invalid_input', r.text);
r = await call('GET', '/products?limit=0');
check('list limit 0 400', r.status === 400, r.text);
r = await call('GET', '/products?offset=-1');
check('list offset -1 400', r.status === 400, r.text);
r = await call('GET', '/products?limit=abc');
check('list limit abc 400', r.status === 400, r.text);

const sku = 'T-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
r = await call('POST', '/products', { sku, name: 'Test', quantity: 10, price_cents: 250, extra: true });
check('create 201', r.status === 201 && sameKeys(r.json, PRODUCT_KEYS) && r.json.sku === sku && r.json.quantity === 10, r.text);
const id = r.json?.id;
r = await call('POST', '/products', { sku, name: 'Test', quantity: 10, price_cents: 250 });
check('create duplicate 409', r.status === 409 && r.json?.error === 'conflict', r.text);
r = await call('POST', '/products', { sku: '', name: 'x', quantity: 1, price_cents: 1 });
check('create empty sku 400', r.status === 400 && r.json?.error === 'invalid_input', r.text);
r = await call('POST', '/products', { sku: 'x'.repeat(65), name: 'x', quantity: 1, price_cents: 1 });
check('create sku too long 400', r.status === 400, r.text);
r = await call('POST', '/products', { sku: 'y' + sku, name: 'x', quantity: -1, price_cents: 1 });
check('create negative qty 400', r.status === 400, r.text);
r = await call('POST', '/products', { sku: 'z' + sku, name: 'x', quantity: '1', price_cents: 1 });
check('create qty as string 400', r.status === 400, r.text);
r = await call('POST', '/products', { sku: 'w' + sku, name: 'x', price_cents: 1 });
check('create missing qty 400', r.status === 400, r.text);
r = await call('POST', '/products', undefined, '{not json');
check('create bad json 400', r.status === 400 && r.json?.error === 'invalid_input', r.text);

r = await call('POST', `/products/${id}/movements`, { delta: -4, reason: 'sale' });
check('movement out 200', r.status === 200 && r.json?.product_id === id && r.json?.quantity === 6 && typeof r.json?.movement_id === 'number' && sameKeys(r.json, ['product_id', 'quantity', 'movement_id']), r.text);
r = await call('POST', `/products/${id}/movements`, { delta: 5, reason: 'restock' });
check('movement in 200', r.status === 200 && r.json?.quantity === 11, r.text);
r = await call('POST', `/products/${id}/movements`, { delta: -12, reason: 'sale' });
check('movement insufficient 409', r.status === 409 && r.json?.error === 'insufficient_stock', r.text);
r = await call('POST', '/products/99999999/movements', { delta: 1, reason: 'x' });
check('movement missing product 404', r.status === 404 && r.json?.error === 'not_found', r.text);
r = await call('POST', `/products/${id}/movements`, { delta: 0, reason: 'x' });
check('movement delta 0 400', r.status === 400, r.text);
r = await call('POST', `/products/${id}/movements`, { delta: 1, reason: '' });
check('movement empty reason 400', r.status === 400, r.text);
r = await call('POST', `/products/${id}/movements`, { delta: 1.5, reason: 'x' });
check('movement float delta 400', r.status === 400, r.text);
r = await call('GET', `/products/${id}`);
check('quantity persisted', r.json?.quantity === 11, r.text);

r = await call('GET', '/stats');
check('stats', r.status === 200 && sameKeys(r.json, ['products', 'total_quantity', 'total_value_cents']) && typeof r.json.total_value_cents === 'number' && r.json.products >= 10000, r.text);

r = await call('GET', '/nope');
check('unknown route 404', r.status === 404, r.text);

console.log(failures ? `\n${failures} échec(s)` : '\nTout est conforme');
process.exit(failures ? 1 : 0);

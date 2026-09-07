// Feed the resolved `docker compose config --format json` via stdin.
// Never log the input: it may contain production secrets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(0, 'utf8'));
const services = config.services;
for (const name of ['postgres', 'api', 'web', 'caddy']) {
  const networks = services[name]?.networks ?? {};
  assert.ok(Object.hasOwn(networks, 'backend'), `${name} must join backend`);
}
assert.notEqual(config.networks.backend.internal, true, 'backend must allow outbound LLM traffic');
assert.ok(services.api.dns?.length > 0, 'API needs explicit upstream DNS');
assert.ok(services.api.dns.every(ip => !ip.startsWith('127.')), 'upstream DNS cannot use host loopback');
for (const name of ['api', 'web', 'vision']) {
  assert.equal(services[name]?.ports?.length ?? 0, 0, `${name} must not publish host ports`);
}
assert.ok(services.postgres.ports?.every(port => port.host_ip === '127.0.0.1'), 'Postgres ports must bind to loopback');
assert.equal(services.api.depends_on.postgres.condition, 'service_healthy');
assert.equal(services.api.environment.PERSISTENCE_REQUIRED, 'true');
console.log('PASS: AWS network membership, outbound access, DNS, port exposure and database dependency');

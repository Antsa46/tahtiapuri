// Composition selects one development host for a backend object's lifetime.
// Never release on an uncertain stop or replace it with a status query.
const owners = new WeakSet<object>();
export function claimDevelopmentBackend(backend: object): void {
  if (owners.has(backend)) throw new Error("Development backend already has an owner.");
  owners.add(backend);
}

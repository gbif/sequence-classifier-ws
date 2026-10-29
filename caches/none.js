// No-op cache backend: select with CACHE=none to run without any cache.
// Every lookup misses, so queries always go straight to vsearch; writes are
// discarded. No connections are opened, so there is no error spam when no
// cache server is available.
const getMany = async (namespace, ids) => ids.map(() => null);
const setMany = async () => {};
const disconnect = () => {};
const ready = Promise.resolve();

module.exports = { getMany, setMany, disconnect, ready };

// No-op cache backend: select with CACHE=none to run without any cache.
// Every lookup misses, so queries always go straight to vsearch; writes are
// discarded. No connections are opened, so there is no error spam when no
// cache server is available.
const get = async () => { throw new Error('Not found'); };
const set = async () => {};
const disconnect = () => {};

module.exports = { get, set, disconnect };

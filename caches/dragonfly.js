const { createClient } = require('redis');
const config = require('./config').DRAGONFLY;

const client = createClient({ socket: { host: config.host, port: config.port } });
client.on('error', err => console.error('Cache client error:', err));
client.connect().catch(err => console.error('Cache connection failed:', err));

const set = async (nucleotideSequenceID, database, result) => {
    await client.set(`${database}:${nucleotideSequenceID}`, JSON.stringify(result));
};

const get = async (nucleotideSequenceID, database) => {
    const value = await client.get(`${database}:${nucleotideSequenceID}`);
    if (value === null) throw new Error('Not found');
    return JSON.parse(value);
};

module.exports = { get, set };

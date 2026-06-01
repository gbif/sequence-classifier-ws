const config = require('./config').HBASE;
const thrift = require('thrift'),
  HBase = require('./gen-nodejs/HBase.js'),
  HBaseTypes = require('./gen-nodejs/Hbase_types.js');
 
let connection; 
let client;
const connect = () =>{
    connection = thrift.createConnection(config.hosts[0], config.port, {
        transport: thrift.TBufferedTransport,
        protocol: thrift.TBinaryProtocol
      }); 
     client = thrift.createClient(HBase,connection);

     connection.on('close', function(){ 
        console.log("The connnection closed, reconnecting...")
         connect()
    })
    connection.on('connect', function() {
        client.getTableNames(function(err,data) {
          if (err) {
            console.log('get table names error:', err);
          } else {
           // console.log('hbase tables:', data.map(t => t.toString()));
            const table = data.find(t => t.toString() === config.tableName);
            if(table){
               // console.log(`Hbase table ${config.tableName} found. Cache is ready.`);
                return client;
            } else {
                console.log(`Hbase table ${config.tableName} NOT found. Caching will not work`)
                return null;
            }
          }
        });
      });
}

const set = async (nucleotideSequenceID, database, result) => {
    return new Promise((resolve, reject) => {
        if(client){
            var data = [new HBaseTypes.Mutation({column:'ref:sourcedb','value':database}), new HBaseTypes.Mutation({column:'ref:data','value': JSON.stringify(result)})];
            client.mutateRow(config.tableName, nucleotideSequenceID, data, null, function(error, success){
                if(error){
                    console.log(error)
                    reject()
                } else {
                    resolve()
                   // console.log("Insertion succeeded")
                }
                
            })
        } else {
            reject()
        }
    })
}

const get = async (nucleotideSequenceID, database) => {
    return new Promise((resolve, reject) => {
            if(client){
                client.getRow(config.tableName, nucleotideSequenceID, null, function(error, data){
                    try {
                        if(error){
                            console.log(error)
                            reject(error)
                        } else {
                            // console.log("Get succeeded")
                            let result = data.find(row => (row?.columns?.['ref:sourcedb']?.value ?? '').toString() === database)
                            if(result){
                                const res = JSON.parse(result?.columns?.['ref:data']?.value ?? '');
                                resolve(res) // resolve(parse ? res : res.toString())
                            } else {
                                reject("Not found")
                            }
                           
                        }  
                    } catch (error) {
                        console.log(error)
                    }
                    
                    
                })
            }  else {
                reject();
            }
    })
    
}

connect()
module.exports = {
    set,
    get
};
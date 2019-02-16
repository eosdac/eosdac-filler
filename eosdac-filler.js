#!/usr/bin/env node

const fs = require('fs')
const commander = require('commander');
const { Api, JsonRpc } = require('eosjs');
const { TextDecoder, TextEncoder } = require('text-encoding');
const fetch = require('node-fetch');


var kue = require('kue')
const cluster = require('cluster')

let rpc;
const signatureProvider = null;




const {ActionHandler, TraceHandler, DeltaHandler} = require('./eosdac-handlers')
const BlockReceiver = require('./eosdac-blockreceiver')

// var access = fs.createWriteStream('filler.log')
// process.stdout.write = process.stderr.write = access.write.bind(access)



class FillManager {
    constructor({ startBlock = 0, endBlock = 0xffffffff, config = 'jungle', irreversibleOnly = false, replay = false, test = 0, processOnly = false }) {
        this.config = require(`./${config}.config`)
        this.config_name = config
        this.start_block = startBlock
        this.end_block = endBlock
        this.replay = replay
        this.br = null
        this.test_block = test
        this.job_done = null
        this.process_only = processOnly

        console.log(`Loading config ${config}.config.js`)
    }

    async run(){
        let queue

        let start_block = this.start_block

        // If replay is set then we start from block 0 in parallel and then start a serial handler from lib onwards
        // Otherwise we start from this.start_block in serial

        rpc = new JsonRpc(this.config.eos.endpoint, { fetch });
        this.api = new Api({
            rpc, signatureProvider, chainId:this.config.chainId, textDecoder: new TextDecoder(), textEncoder: new TextEncoder(),
        });

        cluster.on('exit', ((worker, code, signal) => {
            console.log(`Process exit`)
            if (signal) {
                console.log(`FillManager : worker was killed by signal: ${signal}`);
            } else if (code !== 0) {
                console.log(`FillManager : worker exited with error code: ${code}`);
            } else {
                if (this.job_done){
                    // Job success
                    this.job_done()
                }
                console.log('FillManager : worker success!');
            }

            if (worker.isDead()){
                console.log(`Worker is dead, starting a new one`)
                cluster.fork()

                if (worker.isMaster){
                    console.log('Main thread died :(')
                }
                if (this.job_done){
                    this.job_done(new Error("Error - Job died"))
                }
            }
        }).bind(this));

        const action_handler = new ActionHandler({queue, config:this.config})
        const block_handler = new TraceHandler({queue, action_handler, config:this.config})
        const delta_handler = new DeltaHandler({queue, config:this.config})

        if (this.replay){

            queue = kue.createQueue({
                prefix: this.config.redisPrefix,
                redis: this.config.redis
            })

            this.queue = queue


            if (cluster.isMaster){
                kue.app.listen(3000)

                console.log(`Replaying from ${this.start_block} in parallel mode`)

                const info = await this.api.rpc.get_info()
                const lib = info.last_irreversible_block_num

                let chunk_size = 100000
                const range = lib - this.start_block
                console.log(`Range : ${range}`)
                if (chunk_size > (range / this.config.fillClusterSize)){
                    console.log('small chunks')
                    chunk_size = parseInt((range) / this.config.fillClusterSize)
                }
                let from = this.start_block;
                let to = from + chunk_size; // to is not inclusive
                let break_now = false
                let number_jobs = 0
                while (true){
                    console.log(`adding job for ${from} to ${to}`)
                    queue.create('block_range', {from, to}).removeOnComplete( true ).save()
                    number_jobs++

                    if (to == lib){
                        break_now = true
                    }

                    from += chunk_size
                    to += chunk_size

                    if (to > lib){
                        to = lib
                    }

                    if (from > to){
                        break_now = true
                    }

                    // WARNING : debug
                    // if (to > 100000){
                    //     break_now = true;
                    // }

                    if (break_now){
                        break
                    }
                }

                console.log(`Queued ${number_jobs} jobs`)

                for (let i = 0; i < this.config.fillClusterSize; i++) {
                    let worker = cluster.fork()
                }

                // Start in serial mode from lib onwards
                this.br = new BlockReceiver({startBlock:lib, mode:0, config:this.config})
                // this.br.registerTraceHandler(block_handler)
                this.br.registerDeltaHandler(delta_handler)
                this.br.start()
            }
            else {
                queue.process('block_range', 1, this.processBlockRange.bind(this))
            }

        }
        else if (this.test_block){
            queue = kue.createQueue({
                prefix: this.config.redisPrefix,
                redis: this.config.redis
            })
            kue.app.listen(3002)


            const action_handler = new ActionHandler({queue: queue, config: this.config})
            const block_handler = new TraceHandler({queue: queue, action_handler, config: this.config})
            const delta_handler = new DeltaHandler({queue, config:this.config})


            console.log(`Testing single block ${this.test_block}`);
            this.br = new BlockReceiver({startBlock:this.test_block, endBlock:this.test_block+1, mode:1, config:this.config})
            // this.br.registerTraceHandler(block_handler)
            this.br.registerDeltaHandler(delta_handler)
            this.br.start()
        }
        else if (this.process_only){
            queue = kue.createQueue({
                prefix: this.config.redisPrefix,
                redis: this.config.redis
            })

            this.queue = queue

            if (cluster.isMaster){
                kue.app.listen(3000)

                console.log(`Starting block_range listener only`)

                for (let i = 0; i < this.config.fillClusterSize; i++) {
                    let worker = cluster.fork()
                }
            }
            else {
                queue.process('block_range', 1, this.processBlockRange.bind(this))
            }
        }
        else {
            if (start_block === 0){
                // TODO: need to look for restart point
            }

            console.log(`No replay, starting in synchronous mode`)

            this.br = new BlockReceiver({startBlock:start_block, mode:0, config:this.config})
            // this.br.registerTraceHandler(block_handler)
            this.br.registerDeltaHandler(delta_handler)
            this.br.start()
        }

    }

    async processBlockRange(job, done) {
        const start_block = job.data.from
        const end_block = job.data.to

        // used if the process dies
        this.job_done = done

        console.log(`Starting block listener ${start_block} to ${end_block}`)

        if (this.br) {
            console.log("Already have BlockReceiver")
            this.br.restart(start_block, end_block)
        } else {
            const action_handler = new ActionHandler({queue: this.queue, config: this.config})
            const block_handler = new TraceHandler({queue: this.queue, action_handler, config: this.config})
            const delta_handler = new DeltaHandler({queue: this.queue, config:this.config})

            this.br = new BlockReceiver({startBlock: start_block, endBlock: end_block, mode: 1, config: this.config})
            this.br.registerDeltaHandler(delta_handler)
            // this.br.registerTraceHandler(block_handler)
            this.br.registerDoneHandler(() => {
                //console.log(`BlockReceiver completed`, done)
                done()
                console.log(`Finished job ${start_block}-${end_block}`)
            })
            this.br.registerProgressHandler(((progress) => {job.progress(progress, 100)}).bind(this))
            this.br.start()
        }
    }
}

commander
    .version('0.1', '-v, --version')
    .option('-s, --start-block <start-block>', 'Start at this block', parseInt, 0)
    .option('-t, --test <block>', 'Test mode, specify a single block to pull and process', parseInt, 0)
    .option('-e, --end-block <end-block>', 'End block (exclusive)', parseInt, 0xffffffff)
    .option('-c, --config <config>', 'Config prefix, will load <config>.config.js from the current directory',  'jungle')
    .option('-r, --replay', 'Force replay (ignore head block)', false)
    .option('-p, --process-only', 'Only process queue items (do not populate)', false)
    .parse(process.argv);

// const monitor = new Monitor(commander);
// const fill = new FillAPI(commander);

const fm = new FillManager(commander)
fm.run()
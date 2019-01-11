import {OStorageService} from './oStorageService';
import * as Logger from '@restorecommerce/logger';

import * as sconfig from '@restorecommerce/service-config';

import { puts } from 'util';
// Export cfg Object
const cfg = sconfig(process.cwd());


const logger = new Logger(cfg.get('logger'));


const osSrvObj = new OStorageService( cfg.get().s3,logger);

var metaData = {
    'x-amz-meta-Testing': "1234",
};

const call = { request: {
    bucket: "documents", key: 'returnTest', meta: "customMeta",object:  Buffer.from('Bucket test to retreive bucket data'),   //{'Org':'Gellert Hotel','contractId':'123021301'},{'Org':'ibis','contractid':'12312321'}
}}
const bucket = { request: {  bucket: "documents", key: 'returnTest' }};

//  async function getObj()
//  {

//      await osSrvObj.get(bucket,logger)
//  }
//  getObj().then((res)=>{
//      console.log( 'retrived data from bucket is ',res);
//  });


// async function postObj() {
//     await osSrvObj.put(call,logger);
// }

// postObj().then((res => {
//     console.log('Resolved data...',  res);
// }));

import * as _ from 'lodash';
import * as aws from 'aws-sdk';
import * as uuid from 'uuid';
import * as MemoryStream from 'memorystream';
import { PassThrough, Readable } from 'stream';

export interface GetRequest {
  key: string;
  bucket: string;
  flag: boolean;
}

export interface ListBucket {
  bucket: string;
}

export interface DeleteRequest {
  key: string;
  bucket: string;
}

export interface PutRequest {
  key: string;
  bucket: string;
  meta: any;
  object: Buffer;
}

export interface Call<T = GetRequest | DeleteRequest | PutRequest> {
  request: T;
}

export class InvalidBucketName extends Error {
  details: any;
  constructor(details: any) {
    super();
    this.name = this.constructor.name;
    this.message = 'Invalid bucket name';
    this.details = details;
  }
}

export class InvalidKey extends Error {
  details: any;
  constructor(details: any) {
    super();
    this.name = this.constructor.name;
    this.message = 'Invalid key';
    this.details = details;
  }
}

export class OStorageService {
  ossClient: aws.S3; // object storage frameworks are S3-compatible
  buckets: string[];
  host: String;
  constructor(cfg: any, private logger: any) {
    this.ossClient = new aws.S3(cfg.s3.client);
    this.host = cfg.host.endpoint;
    this.buckets = cfg.s3.buckets || [];
  }

  async start(): Promise<void> {
    for (let bucket of this.buckets) {
      await new Promise((resolve, reject) => {
        this.ossClient.createBucket({
          Bucket: bucket
        }, (err, data) => {
          if (err) {
            if (err.statusCode != 409) { // bucket already owned by you
              this.logger.error(`Error creating bucket ${bucket}`);
            }
          }
          resolve(data);
        });
      });
    }
  }

  async list(call: Call<ListBucket>, context?: any): Promise<any> {
    const { bucket } = call.request;
    let buckets = [];
    if (bucket) {
      buckets.push(bucket);
    }
    else {
      buckets = this.buckets;
    }
    let objectToReturn = [];
    for (const value of buckets) {
      if (value != null) {
        let bucketName = { Bucket: value };
        const AllObjects: any = await new Promise((resolve, reject) => {
          this.ossClient.listObjectsV2(bucketName, (err, data) => {
            if (err)
              reject(err);
            else
              return resolve(data.Contents);
          });
        });
        if (AllObjects != null) {
          for (let eachObj of AllObjects) {
            const headobjectParams = { Bucket: value, Key: eachObj.Key };
            const meta: any = await new Promise((resolve, reject) => {
              this.ossClient.headObject(headobjectParams, (err, data) => {
                if (err) {
                  console.log(err, err.stack);
                  reject(err);
                }
                resolve(data.Metadata);
              });
            });
            const url = this.host + value + '/' + meta.key;
            const objectName = meta.key;
            let objectMeta;
            if (meta && meta.meta) {
              objectMeta = JSON.parse(meta.meta);
            }
            let object = { object_name: objectName, url, meta: objectMeta };
            objectToReturn.push(object);
          }
        }
      }
    }
    return objectToReturn;
  }

  async get(call: Call<GetRequest>, context?: any): Promise<any> {
    const { bucket, key, flag } = call.request;
    if (!_.includes(this.buckets, bucket)) {
      throw new InvalidBucketName(bucket);
    }
    if (!key) {
      throw new InvalidKey(key);
    }
    const params = { Bucket: bucket, Key: key };
    if (flag) {
      const meta: any = await new Promise((resolve, reject) => {
        this.ossClient.headObject(params, (err, data) => {
          if (err) {
            console.log(err, err.stack);
            reject(err);
          }
          resolve(data.Metadata);
        });
      });
      let metaObj;
      if (meta && meta.meta) {
        metaObj = JSON.parse(meta.meta);
      }
      return {
        meta: metaObj
      };
    }

    this.logger.verbose(`Received a request to get object ${key} on bucket ${bucket}`);
    const stream = new MemoryStream(null, { readable: false });
    const object = await new Promise<any>((resolve, reject) => {
      this.ossClient.getObject({
        Bucket: bucket,
        Key: key
      })
        .on('httpData', (chunk) => {
          stream.write(chunk);
        })
        .on('httpDone', () => {
          resolve(stream.toBuffer());
        })
        .on('httpError', (err) => {
          this.logger.error('HTTP error ocurred while getting object', { err });
          reject(err);
        })
        .on('error', (err) => {
          this.logger.error('Error ocurred while getting object', { err });
          reject(err);
        })
        .send((err, data) => { resolve(); });
    });
    const url = this.host + bucket + '/' + key;
    return {
      bucket, key, object, url
    };
  }

  async put(call: Call<PutRequest>, context?: any): Promise<any> {
    let { bucket, key, meta, object } = call.request;
    // here Key is fileName from request
    if (!_.includes(this.buckets, bucket)) {
      throw new InvalidBucketName(bucket);
    }
    if (!key) {
      key = uuid.v4().replace(/-/g, '');
    }
    let metaData = {
      meta: JSON.stringify(meta),
      key
    };

    this.logger.verbose(`Received a request to store Object ,${key} on bucket ${bucket}`);
    const readable = new Readable();
    readable.push(object);
    readable.push(null);
    const passStream = new PassThrough();
    const uploadable = this.ossClient.upload({
      Bucket: bucket,
      Key: key,
      Body: passStream,
      Metadata: metaData
    }, (error, data) => { });
    readable.pipe(passStream);

    const output = await new Promise<any>((resolve, reject) => {
      uploadable
        .on('httpUploadProgress', (chunk) => {
          if (chunk.loaded == chunk.total) {
            this.logger.info(`Successfully persisted object ${key}
                          in bucket ${bucket}`);
            resolve(true);
          }
          else reject();
        })
        .send();
    });
    if (output) {
      const url = this.host + bucket + '/' + key;
      return { url, bucket, key };
    }
  }

  async delete(call: Call<DeleteRequest>, context?: any): Promise<void> {
    const { bucket, key } = call.request;
    if (!_.includes(this.buckets, bucket)) {
      throw new InvalidBucketName(bucket);
    }

    this.logger.verbose(`Received a request to delete object ${key} on bucket ${bucket}`);
    const result = await this.ossClient.deleteObject({
      Bucket: bucket,
      Key: key
    }).promise();

    if (result.$response.error) {
      this.logger.error(`Error while deleting object ${key} from bucket ${bucket}`, {
        error: result.$response.error
      });
      throw result.$response.error;
    }
    this.logger.info(`Successfully deleted object ${key} from bucket ${bucket}`);
  }
}



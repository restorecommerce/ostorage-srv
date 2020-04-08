import * as _ from 'lodash';
import * as aws from 'aws-sdk';
import * as MemoryStream from 'memorystream';
import { PassThrough, Readable } from 'stream';
import { errors } from '@restorecommerce/chassis-srv';
import { toObject } from '@restorecommerce/resource-base-interface';

const META_OWNER = 'meta.owner';
const EQ = 'eq';

export enum Operation {
  GT = 'gt',
  LT = 'lt',
  LTE = 'lte',
  GTE = 'gte',
  EQ = 'eq',
  IS_EMPTY = 'isEmpty',
  IN = 'in',
  iLIKE = 'iLike'
}

export interface Options {
  encoding?: string;
  content_type?: string;
  content_language?: string;
  content_disposition?: string;
  length?: number;
  version?: string;
  md5?: string;
}

export interface FilterType {
  field?: string;
  value?: string;
  operation: Operation;
}

export interface RequestType {
  bucket: string;
  filter?: FilterType;
}

export interface GetRequest {
  key: string;
  bucket: string;
  flag: boolean;
}

export interface ListRequest {
  bucket: string;
  filter: FilterType;
}

export interface DeleteRequest {
  key: string;
  bucket: string;
  filter: FilterType;
}

export interface PutRequest {
  key: string;
  bucket: string;
  meta: any;
  object: Buffer;
}

export interface PutResponse {
  key: String;
  bucket: String;
  url: String;
  options?: Options;
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

export class Service {
  ossClient: aws.S3; // object storage frameworks are S3-compatible
  buckets: string[];
  host: String;
  bucketsLifecycleConfigs?: any;

  constructor(cfg: any, private logger: any) {
    this.ossClient = new aws.S3(cfg.s3.client);
    this.host = cfg.host.endpoint;
    this.buckets = cfg.s3.buckets || [];
    this.bucketsLifecycleConfigs = cfg.s3.bucketsLifecycleConfigs;
  }

  async start(): Promise<void> {
    // Create buckets as defined in config.json
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

    // Create bucket lifecycle configuration as defined in config.json

    /*
    Create/update/delete bucket lifecycle configurations
    when a configuration in config.json is given.

    Each bucket can have a lifecycle configuration
    consisting of multiple predefined rules.

    If we provide a configuration which matches the existing
    buckets, then we configure that on the object storage.

    If we remove a configuration for an existing bucket from config.json,
    then we try to remove it from the object storage as-well.

    If we provide a configuration in config.json for a nonexistent bucket,
    we try to remove the configuration from the object storage in an attempt
    to clean-up any possible previous configurations, while logging a warning
    message showing that the config.json should be updated next time.

     */

    // Check if lifecycle configuration is given
    if (this.bucketsLifecycleConfigs) {
      // Read configurations
      const configurations = this.bucketsLifecycleConfigs;
      // Read configuration and map bucket name found in cfg to cfg object itself
      let nameCfgMapping = new Map(); // this mapping holds the bucket names found in config.json
      let cfgBucketNamesList: string[] = [];
      const bucketsList = this.buckets;
      // This input parameter is updated appropriately later
      let bucketParam;
      for (let cfg of configurations) {
        nameCfgMapping.set(cfg.Bucket, cfg);
        // Create a separate list only with the bucket names found in the configurations
        cfgBucketNamesList.push(cfg.Bucket);
      }
      let cfgToAddMapping = new Map(); // this mapping holds which cfg should be added to obj storage
      let cfgToRemoveMapping = new Map(); // this mapping holds which cfg should be removed from obj storage

      // Step 1.
      // Sort which configurations should be added and which should be removed
      // based on configurations given and existing buckets
      for (let i = 0; i < cfgBucketNamesList.length; i++) {
        for (let j = 0; j < bucketsList.length; j++) {

          // If cfg bucket name is the same as the existing bucket name
          // then add the name to the cfgToAddMapping
          if (cfgBucketNamesList[i] == bucketsList[j]) {

            cfgToAddMapping.set(cfgBucketNamesList[i], 0);

            // When adding a new element to cfgToAddMapping this means we have a match
            // so we remove it from cfgToRemoveMapping if found already inside
            if (cfgToRemoveMapping.has(cfgBucketNamesList[i])) {
              cfgToRemoveMapping.delete(cfgBucketNamesList[i]);
            }
            break;
          } else {
            cfgToRemoveMapping.set(cfgBucketNamesList[i], 0);
          }

        }
      }

      // Step 2.
      // Double check if there are any existing buckets
      // which have no configuration provided. If so,
      // add these to the cfgToRemoveMapping too!
      for (let k = 0; k < bucketsList.length; k++) {
        // If bucket doesn't have any configuration provided
        // try to remove the pre-existing configuration!
        if (!cfgToAddMapping.has(bucketsList[k])) {
          cfgToRemoveMapping.set(bucketsList[k], 0);
        }
      }

      // Step 3.
      // Finally after sorting the configurations,
      // execute the required operations

      // 3.1
      // Iterate over cfgToAddMapping keys and PUT the configurations
      let lifecycleParams;
      for (let cfgToAdd of cfgToAddMapping.keys()) {

        bucketParam = {
          Bucket: cfgToAdd
        };

        // Take configuration obj from Mapping
        lifecycleParams = nameCfgMapping.get(cfgToAdd); // this object contains all the required params
        await new Promise((resolve, reject) => {
          this.ossClient.putBucketLifecycleConfiguration(lifecycleParams, (err, data) => {
            if (err) { // an error occurred
              this.logger.error('Error occurred while adding bucket configuration for bucket:',
                {
                  bucket: cfgToAdd, error: err, errorStack: err.stack
                });
            } else { // successful response
              this.logger.info ('Successfully added BucketLifecycleConfiguration for',
                {
                  bucket: cfgToAdd
                });
              resolve(data);
            }
          });
        });
      }

      // 3.2
      // Iterate over cfgToRemoveMapping keys and DELETE the configurations
      for (let cfgToRemove of cfgToRemoveMapping.keys()) {
        bucketParam = {
          Bucket: cfgToRemove
        };

        // Try to get the Bucket's lifecycle configuration which is going to be deleted
        await new Promise((resolve, reject) => {
          this.ossClient.getBucketLifecycleConfiguration(bucketParam, (err, data) => {
            if (err) { // an error occurred
              if (err.code == 'NoSuchBucket') {
                this.logger.warn('Configuration for bucket not found,' +
                  ' please update config file and remove this one from it!',
                {
                  bucket: cfgToRemove, error: err
                });
              } else {
                this.logger.error('Error occurred while retrieving bucket configuration for bucket:',
                  {
                    cfgToRemove, error: err, errorStack: err.stack
                  });
              }
              resolve(err);
            } else { // successful response
              this.logger.info ('Successfully retrieved BucketLifecycleConfiguration for',
                {
                  bucket: cfgToRemove
                });
              resolve(data);
            }
          });
        });

        // Remove only if existent
        await new Promise((resolve, reject) => {
          this.ossClient.deleteBucketLifecycle(bucketParam, (err, data) => {
            if (err) { // an error occurred
              this.logger.error('Error occurred while removing bucket configuration for bucket:',
                {
                  bucket: cfgToRemove, error: err, errorStack: err.stack
                });
              resolve(err);
            } else { // successful response
              this.logger.info ('Successfully removed BucketLifecycleConfiguration',
                {
                  bucket: cfgToRemove
                });
              resolve(data);
            }
          });
        });
      }
    }
  }

  async list(request: Call<ListRequest>, context?: any): Promise<any> {
    let { bucket, filter }  = request.request;

    // if request contains a filter return data based on it
    let hasFilter = false;
    let requestFilter;
    if (filter) {
      hasFilter = true;
      // convert filter from struct back to object
      requestFilter = toObject(filter);
    }
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
            const headObjectParams = { Bucket: value, Key: eachObj.Key };
            const meta: any = await new Promise((resolve, reject) => {
              this.ossClient.headObject(headObjectParams, (err, data) => {
                if (err) {
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

            // if filter is provided return data based on filter
            if (hasFilter && requestFilter.field == META_OWNER && requestFilter.operation == EQ && requestFilter.value) {
              const MetaOwnerVal = object.meta.owner[1].value;
              // check only for the files matching the requested Owner Organizations
              if (requestFilter.value == MetaOwnerVal) {
                objectToReturn.push(object);
              }
            } else { // else return all data
              objectToReturn.push(object);
            }
          }
        }
      }
    }
    return objectToReturn;
  }

  async get(call: any, context?: any): Promise<any> {
    // get gRPC call request
    const { bucket, key, flag, download } = call.request;
    if (!_.includes(this.buckets, bucket)) {
      return await call.end(new InvalidBucketName(bucket));
    }
    if (!key) {
      return await call.end(new InvalidKey(key));
    }
    // get metadata of the object stored in the S3 object storage
    const params = { Bucket: bucket, Key: key };
    let headObject: any;
    if (flag) {
      headObject = await new Promise((resolve, reject) => {
        this.ossClient.headObject(params, async (err: any, data) => {
          if (err) {
            // map the s3 error codes to standard chassis-srv errors
            if (err.code === 'NotFound') {
              err = new errors.NotFound('The specified key was not found');
              err.code = 404;
            }
            this.logger.error('Error occurred retrieving metadata for key:', { key, error: err });
            return await call.end(err);
          }
          resolve(data);
        });
      });

      // capture meta data from response message
      let metaObj;
      if (headObject && headObject.Metadata && headObject.Metadata.meta) {
        metaObj = JSON.parse(headObject.Metadata.meta);
      }

      // capture options from response headers
      // these options are added with the put method
      // with the help of the storeObject() which is
      // using the s3.upload() method
      let encoding, content_type, content_language, content_disposition, length, version, md5;
      if (headObject) {
        if (headObject.ContentEncoding) {
          encoding = headObject.ContentEncoding;
        }
        if (headObject.ContentType) {
          content_type = headObject.ContentType;
        }
        if (headObject.ContentLanguage) {
          content_language = headObject.ContentLanguage;
        }
        // check download param
        if (download) {
          content_disposition = 'attachment';
        } else {
          content_disposition = 'inline';
        }
        if (headObject.ContentLength) {
          length = headObject.ContentLength;
        }
        if (headObject.ETag) {
          md5 = headObject.ETag;
        }
        if (headObject['x-amz-version-id']) {
          version = headObject['x-amz-version-id'];
        }
      }
      const optionsObj: Options = { encoding, content_type, content_language, content_disposition, length, version, md5 };

      // write meta data and options to the gRPC call
      await call.write({ meta: metaObj, options:optionsObj });
      await call.end();
      return;
    }

    this.logger.verbose(`Received a request to get object ${key} on bucket ${bucket}`);

    // retrieve object from Amazon S3
    // and create stream from it
    const stream = new MemoryStream(null);
    const downloadable = this.ossClient.getObject({ Bucket: bucket, Key: key }).createReadStream();
    stream.pipe(downloadable);
    // write data to gRPC call
    await new Promise<any>((resolve, reject) => {
      downloadable
        .on('httpData', async (chunk) => {
          await call.write({ bucket, key, object: chunk, url: this.host + bucket + '/' + key });
        })
        .on('data', async (chunk) => {
          await call.write({ bucket, key, object: chunk, url: this.host + bucket + '/' + key });
        })
        .on('httpDone', async () => {
          resolve();
        })
        .on('end', async (chunk) => {
          await call.end();
          resolve();
        })
        .on('finish', async (chunk) => {
          await call.end();
          resolve();
        })
        .on('httpError', async (err: any) => {
          this.logger.error('HTTP error occurred while getting object', { err });
          // map the s3 error codes to standard chassis-srv errors
          if (err.code === 'NotFound') {
            err = new errors.NotFound('The specified key was not found');
            err.code = 404;
          }
          await call.end(err);
        })
        .on('error', async (err: any) => {
          this.logger.error('Error occurred while getting object', { err });
          // map the s3 error codes to standard chassis-srv errors
          if (err.code === 'NotFound') {
            err = new errors.NotFound('The specified key was not found');
            err.code = 404;
          }
          await call.end(err);
        });
    });
    return;
  }

  async put(call: any, callback: any): Promise<PutResponse> {
    let stream = true;
    let completeBuffer = [];
    let key, bucket, meta, object, options;
    while (stream) {
      try {
        let req = await call.read();
        // Promisify callback to get response
        req = await new Promise((resolve, reject) => {
          req((err, response) => {
            if (err) {
              reject(err);
            }
            resolve(response);
          });
        });
        key = req.key;
        bucket = req.bucket;
        object = req.object;
        meta = req.meta;
        options = req.options;
        if (!_.includes(this.buckets, bucket)) {
          stream = false;
          throw new InvalidBucketName(bucket);
        }
        completeBuffer.push(object);
      } catch (e) {
        stream = false;
        if (e.message === 'stream end') {
          // store object to storage server using streaming connection
          const response = await this.storeObject(
            key,
            bucket,
            Buffer.concat(completeBuffer), // object
            meta,
            options
          );
          return response;
        }
      }
    }
  }

  private async storeObject(key: string, bucket: string, object: any, meta: any, options: Options): Promise<PutResponse> {
    try {
      let metaData = {
        meta: JSON.stringify(meta),
        key,
      };
      this.logger.verbose(`Received a request to store Object ${key} on bucket ${bucket}`);
      const readable = new Readable();
      readable.push(object);
      readable.push(null);
      const passStream = new PassThrough();

      // write headers to the S3 object
      const uploadable = this.ossClient.upload({
        Key: key,
        Bucket: bucket,
        Body: passStream,
        Metadata: metaData,
        // options:
        ContentEncoding: options && options.encoding,
        ContentType: options && options.content_type,
        ContentLanguage: options && options.content_language,
        ContentDisposition: options && options.content_disposition,
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
          })
          .send();
      });
      if (output) {
        const url = this.host + bucket + '/' + key;
        const ret =  { url, key, bucket, meta };
        return ret;
      }
    } catch (err) {
      this.logger.error('Error occurred when storing Object:', { err });
      throw err;
    }
  }

  async delete(call: Call<DeleteRequest>, context?: any): Promise<void> {
    const { bucket, key } = call.request;
    if (!_.includes(this.buckets, bucket)) {
      throw new InvalidBucketName(bucket);
    }

    this.logger.verbose(`Received a request to delete object ${key} on bucket ${bucket}`);
    const objectsList = await this.list(call);
    let objectExists = false;
    for (let object of objectsList) {
      if (object.object_name.indexOf(key) > -1) {
        objectExists = true;
        break;
      }
    }
    if (!objectExists) {
      throw new InvalidKey(key);
    }
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

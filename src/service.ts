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

export interface Attribute {
  id?: string;
  value?: string;
}

export interface Options {
  encoding?: string;
  content_type?: string;
  content_language?: string;
  content_disposition?: string;
  length?: number;
  version?: string;
  md5?: string;
  tags?: Attribute[];
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

export interface CopyRequest {
  bucket: string;
  copySource: string;
  key: string;
  meta: Meta;
  options: Options;
}

export interface CopyResponse {
  bucket: string;
  copySource: string;
  key: string;
  meta: Meta;
  options: Options;
}

export interface CopyRequestList {
  items: CopyRequest[];
}

export interface CopyResponseList {
  response: CopyResponse[];
}

// Parameters passed to the S3 copyObject function
// When replacing an object's metadata ( same object inside the same bucket) either "tagging" or "metadata" is required.
// When copying the object to another bucket these two params can be skipped but object will be copied with no metadata.
export interface CopyObjectParams {
  Bucket: string;
  CopySource: string;
  Key: string;
  ContentEncoding?: string;
  ContentType?: string;
  ContentLanguage?: string;
  ContentDisposition?: string;
  SSECustomerKeyMD5?: string;
  TaggingDirective?: string; // "COPY || REPLACE"
  Tagging?: string; // encoded as URL Query parameters.
  MetadataDirective?: string; // "COPY || REPLACE"
  Metadata?: any;
}

export interface Owner {
  id: string;
  value: string;
}

export interface Meta {
  created: number; // timestamp
  modified: number; // timestamp
  modified_by: string; // ID from last User who modified it
  owner: Owner[];
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

export class IsValidObjectName extends Error {
  details: any;
  constructor(details: any) {
    super();
    this.name = this.constructor.name;
    this.message = 'Invalid object name';
    this.details = details;
  }
}

export class Service {
  ossClient: aws.S3; // object storage frameworks are S3-compatible
  buckets: string[];
  bucketsLifecycleConfigs?: any;

  constructor(cfg: any, private logger: any) {
    this.ossClient = new aws.S3(cfg.s3.client);
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

    // Bucket lifecycle configuration
    // get a list of all the bucket names for which rules exist
    let existingBucketRules = [];
    // bucket names for which the existing rules should be deleted
    let deleteBucketRules = [];
    // bucket names for the rules in configuration
    let updateBucketRules = [];

    for (let bucket of this.buckets) {
      await new Promise((resolve, reject) => {
        this.ossClient.getBucketLifecycleConfiguration({ Bucket: bucket }, (err, data) => {
          if (err) {
            this.logger.info(`No rules are preconfigured for bucket: ${bucket}`);
            resolve(err);
          }
          if (data && data.Rules) {
            existingBucketRules.push(bucket);
            resolve(data);
          }
        });
      });
    }

    // Check if lifecycle configuration is given
    if (this.bucketsLifecycleConfigs) {
      // check if there are any bucket rules to be removed
      for (let bucketLifecycleConfiguration of this.bucketsLifecycleConfigs) {
        updateBucketRules.push(bucketLifecycleConfiguration.Bucket);
      }

      for (let existingBucketRule of existingBucketRules) {
        if (!updateBucketRules.includes(existingBucketRule)) {
          deleteBucketRules.push(existingBucketRule);
        }
      }

      // delete rules
      for (let bucket of deleteBucketRules) {
        await new Promise((resolve, reject) => {
          this.ossClient.deleteBucketLifecycle({Bucket: bucket}, (err, data) => {
            if (err) { // an error occurred
              this.logger.error('Error occurred while removing bucket configuration for bucket:',
                {
                  Bucket: bucket, error: err, errorStack: err.stack
                });
              reject(err);
              return;
            } else { // successful response
              this.logger.info(`Successfully removed BucketLifecycleConfiguration for bucket: ${bucket}`);
              resolve(data);
            }
          });
        });
      }

      // Upsert rules
      for (let bucketLifecycleParams of this.bucketsLifecycleConfigs) {
        let bucketName = bucketLifecycleParams.Bucket;
        await new Promise((resolve, reject) => {
          this.ossClient.putBucketLifecycleConfiguration(bucketLifecycleParams, (err, data) => {
            if (err) { // an error occurred
              this.logger.error('Error occurred while adding bucket configuration for:',
                {
                  bucket: bucketName, error: err, errorStack: err.stack
                });
            } else { // successful response
              this.logger.info (`Successfully added BucketLifecycleConfiguration for bucket: ${bucketName}`);
              resolve(data);
            }
          });
        });
      }
    } else {
      // Check old rules if they exist in all the buckets and delete them.
      // This is for use case if the configurations were added previously and all of them are removed now.
      for (let existingBucketRule of existingBucketRules) {
        await new Promise((resolve, reject) => {
          this.ossClient.deleteBucketLifecycle({Bucket: existingBucketRule}, (err, data) => {
            if (err) { // an error occurred
              this.logger.error('Error occurred while removing bucket configuration for bucket:',
                {
                  bucket: existingBucketRule, error: err, errorStack: err.stack
                });
              reject(err);
              return;
            } else { // successful response
              this.logger.info(`Successfully removed BucketLifecycleConfiguration for bucket: ${existingBucketRule}`);
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
            const url = `//${value}/${meta.key}`;
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
            this.logger.error('Error occurred while retrieving metadata for key:', { Key: key, error: err });
            return await call.end(err);
          }
          resolve(data);
        });
      });

      // get object tagging of the object stored in the S3 object storage
      let objectTagging: any;
      try {
        objectTagging = await new Promise((resolve, reject) => {
          this.ossClient.getObjectTagging(params, async (err: any, data) => {
            if (err) {
              // map the s3 error codes to standard chassis-srv errors
              if (err.code === 'NotFound') {
                err = new errors.NotFound('The specified key was not found');
                err.code = 404;
              }
              this.logger.error('Error occurred while retrieving tags for key:', { Key: key, error: err });
              return await call.end(err);
            }
            resolve(data);
          });
        });
      } catch (err) {
        this.logger.info('No object tagging found for key:', {Key: key});
      }
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
      let tags: Attribute[] = [];
      let tagObj: Attribute;
      if (objectTagging) {
        // transform received object to respect our own defined structure
        let receivedTags = objectTagging.TagSet;

        for (let i = 0; i < receivedTags.length; i++ ) {
          tagObj = {
            id: receivedTags[i].Key,
            value: receivedTags[i].Value
          };
          tags.push(tagObj);
        }
      }

      const optionsObj: Options = { encoding, content_type, content_language, content_disposition, length, version, md5, tags };

      // write meta data and options to the gRPC call
      await call.write({ meta: metaObj, options: optionsObj });
      await call.end();
      return;
    }

    this.logger.verbose(`Received a request to get object ${ key } on bucket ${ bucket }`);

    // retrieve object from Amazon S3
    // and create stream from it
    const stream = new MemoryStream(null);
    const downloadable = this.ossClient.getObject({ Bucket: bucket, Key: key }).createReadStream();
    stream.pipe(downloadable);
    // write data to gRPC call
    await new Promise<any>((resolve, reject) => {
      downloadable
        .on('httpData', async (chunk) => {
          await call.write({ bucket, key, object: chunk, url: `//${bucket}/${key}` });
        })
        .on('data', async (chunk) => {
          await call.write({ bucket, key, object: chunk, url: `//${bucket}/${key}` });
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
        bucket = req.bucket;
        key = req.key;
        meta = req.meta;
        object = req.object;
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

  async copy(call: any, callback: any): Promise<CopyResponseList> {
    const request = await call.request;
    let bucket: string;
    let copySource: string;
    let key: string;
    let meta: Meta;
    let options: Options;
    let grpcResponse: CopyResponseList = { response: [] };
    let copyObjectResult;

    if (request && request.items) {
      const itemsList = request.items;
      for (const item of itemsList) {
        bucket = item.bucket;
        copySource = item.copySource;
        key = item.key;
        meta = item.meta;
        options = item.options;

        // Regex to extract bucket name and key from copySource
        // ex: copySource= /bucketName/sample-directory/objectName.txt
        let copySourceStr = copySource.slice(1, copySource.length);
        const sourceBucketName = copySourceStr.substring(0, copySourceStr.indexOf('/'));
        const sourceKeyName = copySourceStr.substr(copySourceStr.indexOf('/'), copySourceStr.length);

        // Start - Compose the copyObject params
        let params: CopyObjectParams = {
          Bucket: bucket,
          CopySource: copySource,
          Key: key
        };

        // need to iterate and check if there is at least one key set
        // since the gRPC adds default values for missing fields
        let optionsExist = false;
        let optionKeys = Object.keys(options);
        for (let optKey of optionKeys) {
          if(!_.isEmpty(options[optKey])) {
            optionsExist = true;
            break;
          }
        }

        // CASE 1: User provides at least one option => replace all obj meta including tagging

        if (optionsExist) {
          params.MetadataDirective = 'REPLACE';
          params.TaggingDirective = 'REPLACE';

          // 1. Add user defined Metadata (this is always generated based on the orgKey input in facade)
          if (!_.isEmpty(meta)) {
            params.Metadata = {
              meta: JSON.stringify(meta),
              key,
            };
          } else {
            this.logger.error('User has not provided any orgKey!');
          }

          // 2. Add object metadata if provided
          // ContentEncoding
          if (!_.isEmpty(options.encoding)) {
            params.ContentEncoding = options.encoding;
          }
          // ContentType
          if (!_.isEmpty(options.content_type)) {
            params.ContentType = options.content_type;
          }
          // ContentLanguage
          if (!_.isEmpty(options.content_language)) {
            params.ContentLanguage = options.content_language;
          }
          // ContentDisposition
          if (!_.isEmpty(options.content_disposition)) {
            params.ContentDisposition = options.content_disposition;
          }

          // 3. Add Tagging if provided [ first convert array of tags to query parameters (it is required by S3) ]
          let TaggingQueryParams = '';
          let tagId: string, tagVal: string;
          if (!_.isEmpty(options.tags)) {
            const tagsList = options.tags;
            for (const [i, v] of tagsList.entries()) {
              tagId = v.id;
              tagVal = v.value;
              if(i < options.tags.length - 1) {
                TaggingQueryParams += tagId + '=' + tagVal + '&';
              } else {
                TaggingQueryParams += tagId + '=' + tagVal;
              }
            }
          }
          if (!_.isEmpty(TaggingQueryParams)) {
            params.Tagging = TaggingQueryParams;
          }

          // End - Compose the copyObject params

          // 4. Copy object with new metadata
          copyObjectResult = await new Promise((resolve, reject) => {
            this.ossClient.copyObject(params, async (err: any, data) => {
              if (err) {
                this.logger.error('Error occurred while copying object:',
                  {
                    Bucket: bucket, Key: key, error: err, errorStack: err.stack
                  });
                reject(err);
              } else {
                const eTag = data.CopyObjectResult.ETag;
                const lastModified = data.CopyObjectResult.LastModified;
                this.logger.info('Copy object successful!', {
                  Bucket: bucket, Key: key, ETag: eTag, LastModified: lastModified
                });
                resolve(data);
              }
            });
          });

        } else {

          // CASE 2: No options provided => copy the object as it is and update user defined metadata (owner)

          // 1. Add user defined Metadata ( this is always generated based on the orgKey input in facade )
          params.MetadataDirective = 'REPLACE';
          if (!_.isEmpty(meta)) {
            params.Metadata = {
              meta: JSON.stringify(meta),
              key,
            };
          } else {
            this.logger.error('User has not provided any orgKey!');
          }

          // 2. Add Object metadata
          // Get the source object's metadata and add it to our copied object
          const headObjectParams  = { Bucket: sourceBucketName, Key: sourceKeyName };
          const objectMeta: any = await new Promise((resolve, reject) => {
            this.ossClient.headObject(headObjectParams, (err, data) => {
              if (err) {
                this.logger.error('Error occurred while retrieving metadata for object:',
                  {
                    Bucket: sourceBucketName, Key: sourceKeyName, error: err, errorStack: err.stack
                  });
                reject(err);
              } else {
                resolve(data);
              }
            });
          });

          if (objectMeta) {
            // ContentEncoding
            if (objectMeta.ContentEncoding && !_.isEmpty(objectMeta.ContentEncoding)) {
              params.ContentEncoding = objectMeta.ContentEncoding;
            }
            // ContentType
            if (objectMeta.ContentType && !_.isEmpty(objectMeta.ContentType)) {
              params.ContentType = objectMeta.ContentType;
            }
            // ContentLanguage
            if (objectMeta.ContentLanguage && !_.isEmpty(objectMeta.ContentLanguage)) {
              params.ContentLanguage = objectMeta.ContentLanguage;
            }
            // ContentDisposition
            if (objectMeta.ContentDisposition && !_.isEmpty(objectMeta.ContentDisposition)) {
              params.ContentDisposition = objectMeta.ContentDisposition;
            }
          }

          // 3. Add Tagging
          // Get the source object's existing tagging and add it to our object
          const objectTagging: any = await new Promise((resolve, reject) => {
            this.ossClient.getObjectTagging(headObjectParams, async (err: any, data) => {
              if (err) {
                this.logger.error('Error occurred while retrieving tagging for object:',
                  {
                    Bucket: sourceBucketName, Key: sourceKeyName, error: err, errorStack: err.stack
                  });
                resolve(err); // resolve if err, this does not stop the service when tagging not found
              } else {
                resolve(data);
              }
            });
          });
          if (objectTagging && !_.isEmpty(objectTagging.TagSet)) {
            // first convert array of tags to query parameters (it is required by S3)
            let TaggingQueryParams = '';
            let tagId: string, tagVal: string;
            const tagsList = objectTagging.TagSet;
            for (const [i, v] of tagsList.entries()) {
              tagId = v.Key;
              tagVal = v.Value;
              if(i < tagsList.length - 1) {
                TaggingQueryParams += tagId + '=' + tagVal + '&';
              } else {
                TaggingQueryParams += tagId + '=' + tagVal;
              }
            }
            if (!_.isEmpty(TaggingQueryParams)) {
              params.TaggingDirective = 'REPLACE';
              params.Tagging = TaggingQueryParams;
            }
          }

          // End - Compose the copyObject params

          // 4. Copy object with new metadata
          copyObjectResult = await new Promise((resolve, reject) => {
            this.ossClient.copyObject(params, async (err: any, data) => {
              if (err) {
                this.logger.error('Error occurred while copying object:',
                  {
                    Bucket: bucket, Key: key, error: err, errorStack: err.stack
                  });
                reject(err);
              } else {
                const eTag = data.CopyObjectResult.ETag;
                const lastModified = data.CopyObjectResult.LastModified;
                this.logger.info('Copy object successful!', {
                  Bucket: bucket, Key: key, ETag: eTag, LastModified: lastModified
                });
                resolve(data);
              }
            });
          });
        }

        if (copyObjectResult) {
          let copiedObject: CopyResponse = {
            bucket,
            copySource,
            key,
            meta,
            options
          };
          grpcResponse.response.push(copiedObject);
        } else {
          this.logger.error('Copy object failed for:', {DestinationBucket: bucket, CopySource: copySource, Key:key, Meta:meta, Options: options});
        }
      }
    }
    return grpcResponse;
  }

  // Regular expression that checks if the filename string contains
  // only characters described as safe to use in the Amazon S3
  // Object Key Naming Guidelines
  private isValidObjectName(key: string): boolean {
    const allowedCharacters = new RegExp('^[a-zA-Z0-9-!_.*\'()/]+$');
    return (allowedCharacters.test(key));
  }

  private async storeObject(key: string, bucket: string, object: any, meta: any, options: Options): Promise<PutResponse> {
    this.logger.verbose(`Received a request to store Object ${key} on bucket ${bucket}`);
    if (!this.isValidObjectName(key)) {
      throw new IsValidObjectName(key);
    }

    try {
      let metaData = {
        meta: JSON.stringify(meta),
        key,
      };
      // add stream of data into a readable stream
      const readable = new Readable();
      readable.push(object);
      readable.push(null);
      // create writable stream in which we pipe the readable stream
      const passStream = new PassThrough();
      // get object length
      let length: number;
      length = readable.readableLength;

      // convert array of tags to query parameters
      // required by AWS.S3
      let TaggingQueryParams = '';
      let tagId: string, tagVal: string;
      if (options && options.tags) {
        let tags = options.tags;
        for (const [i, v] of tags.entries()) {
          tagId = v.id;
          tagVal = v.value;
          if(i < tags.length - 1) {
            TaggingQueryParams += tagId + '=' + tagVal + '&';
          } else {
            TaggingQueryParams += tagId + '=' + tagVal;
          }
        }
      }
      // write headers to the S3 object
      if (!options) {
        options = {};
      }
      const uploadable = this.ossClient.upload({
        Key: key,
        Bucket: bucket,
        Body: passStream,
        Metadata: metaData,
        // options:
        ContentEncoding: options.encoding,
        ContentType: options.content_type,
        ContentLanguage: options.content_language,
        ContentDisposition: options.content_disposition,
        Tagging: TaggingQueryParams // this param looks like 'key1=val1&key2=val2'
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
        const url = `//${bucket}/${key}`;
        const tags = options && options.tags;
        const ret =  { url, key, bucket, meta, tags, length };
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

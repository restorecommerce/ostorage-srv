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
  key?: string;
  bucket?: string;
  url?: string;
  meta?: any;
  tags?: Attribute[];
  length?: number;
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

export class InvalidObjectName extends Error {
  details: any;
  constructor(details: any) {
    super();
    this.name = this.constructor.name;
    this.message = 'Invalid object name';
    this.details = details;
  }
}

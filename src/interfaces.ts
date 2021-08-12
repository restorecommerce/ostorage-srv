import { Subject } from '@restorecommerce/acs-client';
import { FilterOp } from '@restorecommerce/resource-base-interface';

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
  attribute?: Attribute[];
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
  data?: any;
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
  request: GRequest;
}

export interface GRequest {
  key: string;
  bucket: string;
  flag: boolean;
}

export interface ListRequest {
  bucket: string;
  filters: FilterOp;
  subject?: Subject;
}

export interface ObjectData {
  object_name?: string;
  url?: string;
  meta?: Meta;
}

export interface ObjectsDataWithPayloadStatus {
  payload?: ObjectData;
  status?: Status;
}

export interface ListResponse {
  response?: ObjectsDataWithPayloadStatus[];
  operation_status?: OperationStatus;
}

export interface DeleteRequest {
  key: string;
  bucket: string;
  filter: FilterType;
  subject?: Subject;
}

export interface PutRequest {
  key: string;
  bucket: string;
  meta: any;
  object: Buffer;
}

export interface Status {
  id: string;
  code: number;
  message: string;
}

export interface OperationStatus {
  code: number;
  message: string;
}

export interface PutResponsePayload {
  key?: string;
  bucket?: string;
  url?: string;
  meta?: any;
  tags?: Attribute[];
  length?: number;
}

export interface PutResponseWithPayloadStatus {
  payload: PutResponsePayload;
  status: Status;
}

export interface PutResponse {
  response: PutResponseWithPayloadStatus;
  operation_status: OperationStatus;
}

export interface DeleteResponse {
  status: Status;
  operation_status: OperationStatus;
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

export interface CopyResponseWithPayloadStatus {
  payload?: CopyResponse;
  status?: Status;
}

export interface CopyResponseList {
  response?: CopyResponseWithPayloadStatus[];
  operation_status?: OperationStatus;
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

export interface AttributeObj {
  attribute: Attribute[];
}

export interface Meta {
  created: number; // timestamp
  modified: number; // timestamp
  modified_by: string; // ID from last User who modified it
  owner: Owner[];
  acl?: AttributeObj[];
}

export interface Call<T = GetRequest | DeleteRequest | PutRequest> {
  request: T;
}

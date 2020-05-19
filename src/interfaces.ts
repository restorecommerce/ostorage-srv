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
  id: string;
  value: string;
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
  meta: any;
  options?: Options;
}

export interface Call<T = GetRequest | DeleteRequest | PutRequest> {
  request: T;
}

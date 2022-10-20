export interface HeadObjectParams{
  Bucket: string;
  Key: string;
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

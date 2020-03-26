const aws = require('aws-sdk');
const cfg = {
  "s3": {
    "client": {
      "accessKeyId": "accessKey",
      "secretAccessKey": "secretKey",
      "endpoint": "http://127.0.0.1:9000",
      "s3ForcePathStyle": true
    },
    "buckets": [
      "invoices",
      "usercontent"
    ]
  }
};

// CHANGE CLIENT CONFIGS accordingly
const ossClient = new aws.S3(cfg.s3.client);

const getObject = async(bucket, key): Promise<any> => {
  let response = await new Promise((resolve, reject) => {
    ossClient.getObject({ Bucket: bucket, Key: key }, (err, data) => {
      if(err) {
        return reject(err);
      }
      if (data) {
        resolve(data);
      }
    });
  });
  console.log('Response is...', response);
};

let bucket = 'usercontent';
let key = 'Invoice_2020_January.pdf';

getObject(bucket, key).then((value) => {
  console.log('Response is...', value);
});

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from './config';

let s3: S3Client | undefined;

function getS3(): S3Client {
  s3 ??= new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    credentials:
      config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
        : undefined,
  });
  return s3;
}

/** Uploads a local file and returns its public URL. */
export async function saveFile(localPath: string, key: string, contentType = 'video/mp4'): Promise<string> {
  if (config.STORAGE_DRIVER === 's3') {
    const { size } = await fsp.stat(localPath);
    await getS3().send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
        Body: fs.createReadStream(localPath),
        ContentLength: size,
        ContentType: contentType,
      }),
    );
    return `${config.S3_PUBLIC_URL!.replace(/\/$/, '')}/${key}`;
  }

  const dest = path.join(config.STORAGE_DIR, key);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(localPath, dest);
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/media/${key}`;
}

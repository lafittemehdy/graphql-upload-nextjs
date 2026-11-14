/** Stores example uploads under exclusive names and removes partial files on failure. */
import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { File, StreamingFile } from "graphql-upload-nextjs";

export interface GraphQLFileResponse {
  encoding: string;
  filename: string;
  fileSize: number;
  mimetype: string;
  uri: string;
}

export const ALLOWED_TYPES = ["image/jpeg", "image/png", "text/plain"];
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

export async function processAndStoreFile(
  file: File | StreamingFile,
): Promise<GraphQLFileResponse> {
  if (!ALLOWED_TYPES.includes(file.mimetype))
    throw new Error("File type is not allowed.");
  if (typeof file.fileSize === "number" && file.fileSize > MAX_FILE_SIZE)
    throw new Error("File size limit exceeded.");
  const extension =
    file.mimetype === "image/jpeg"
      ? "jpg"
      : file.mimetype === "image/png"
        ? "png"
        : "txt";
  const storedName = `${randomUUID()}.${extension}`;
  const directory = path.join(process.cwd(), "uploads");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, storedName);
  const handle = await open(destination, "wx", 0o600);
  try {
    await pipeline(file.createReadStream(), handle.createWriteStream());
    const fileSize = await file.fileSize;
    if (fileSize > MAX_FILE_SIZE) throw new Error("File size limit exceeded.");
    return {
      encoding: file.encoding,
      filename: path.basename(file.filename),
      fileSize,
      mimetype: file.mimetype,
      uri: `/uploads/${storedName}`,
    };
  } catch (error) {
    await handle.close();
    await unlink(destination);
    throw error;
  }
}

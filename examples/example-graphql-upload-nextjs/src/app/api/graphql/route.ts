/** Demonstrates the backward-compatible buffered multipart endpoint. */
import { uploadProcess } from "graphql-upload-nextjs";
import type { NextRequest } from "next/server.js";
import {
  ALLOWED_TYPES,
  contextHandler,
  handler,
  MAX_FILE_SIZE,
  server,
} from "../../../lib/graphql";

const requestHandler = async (request: NextRequest) => {
  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    return uploadProcess(request, await contextHandler(request), server, {
      allowedTypes: ALLOWED_TYPES,
      maxFileSize: MAX_FILE_SIZE,
      maxFiles: 10,
    });
  }
  return handler(request);
};

export const GET = requestHandler;
export const OPTIONS = requestHandler;
export const POST = requestHandler;

/** Demonstrates opt-in multipart streaming using the Node.js runtime. */
import { uploadProcessStreaming } from "graphql-upload-nextjs";
import type { NextRequest } from "next/server.js";
import {
  ALLOWED_TYPES,
  contextHandler,
  MAX_FILE_SIZE,
  server,
} from "../../../lib/graphql";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return uploadProcessStreaming(
    request,
    await contextHandler(request),
    server,
    {
      allowedTypes: ALLOWED_TYPES,
      maxFileSize: MAX_FILE_SIZE,
      maxFiles: 10,
    },
  );
}

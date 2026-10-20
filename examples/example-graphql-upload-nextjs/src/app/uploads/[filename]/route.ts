import { readFile } from "node:fs/promises";
import path from "node:path";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  if (!/^[a-f0-9-]{36}\.(jpg|png|txt)$/.test(filename)) {
    return new Response(null, { status: 404 });
  }
  try {
    const content = await readFile(
      path.join(process.cwd(), "uploads", filename),
    );
    const type = filename.endsWith(".jpg")
      ? "image/jpeg"
      : filename.endsWith(".png")
        ? "image/png"
        : "text/plain";
    return new Response(new Uint8Array(content), {
      headers: {
        "Content-Type": type,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return new Response(null, { status: 404 });
    throw error;
  }
}

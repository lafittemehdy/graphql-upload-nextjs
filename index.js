import { UploadRequestError, checkUploadRequest, executeOperations, prepareOperations, processUpload, uploadErrorResponse, } from './core.js';
export { GraphQLUpload, Upload, bufferToStream, parseOperationsJSON, sanitizeAndValidateJSON, setValueAtPath, streamToBuffer, validateMap, } from './core.js';
export { uploadProcessStreaming } from './streaming.js';
/** Fully receives files before executing GraphQL; existing callers retain numeric file sizes. */
export async function uploadProcess(request, contextValueInput, server, settings) {
    try {
        checkUploadRequest(request.headers, settings);
        let formData;
        try {
            formData = await request.formData();
        }
        catch {
            throw new UploadRequestError('Invalid multipart request body.');
        }
        const entries = [...formData.entries()].filter((entry) => entry[1] instanceof globalThis.File);
        if (settings?.maxFiles !== undefined && entries.length > settings.maxFiles) {
            throw new UploadRequestError(`${settings.maxFiles} max file uploads exceeded.`, 413);
        }
        const operationsRaw = formData.get('operations');
        const mapRaw = formData.get('map');
        if (typeof operationsRaw !== 'string' || typeof mapRaw !== 'string' ||
            formData.getAll('operations').length !== 1 || formData.getAll('map').length !== 1) {
            throw new UploadRequestError('Missing, duplicate, or invalid map/operations in form data.');
        }
        const files = new Map();
        for (const [field, file] of entries) {
            if (files.has(field))
                throw new UploadRequestError('Duplicate multipart file field.');
            if (settings?.maxFileSize !== undefined && file.size > settings.maxFileSize) {
                throw new UploadRequestError(`File ${file.name} size is too large.`, 413);
            }
            files.set(field, file);
        }
        const { operations, uploads } = prepareOperations(operationsRaw, mapRaw, settings?.maxFiles);
        await Promise.all([...uploads].map(async ([field, upload]) => {
            const file = files.get(field);
            if (!file) {
                upload.reject(new Error('File missing in the request.'));
                return;
            }
            try {
                upload.resolve(await processUpload(file, settings?.allowedTypes));
            }
            catch (error) {
                upload.reject(new Error(`Failed to process file ${file.name}: ${error.message}`));
            }
        }));
        return await executeOperations(operations, contextValueInput, server);
    }
    catch (error) {
        return uploadErrorResponse(error);
    }
}

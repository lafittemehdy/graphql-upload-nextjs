import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { FormData, File as UndiciFile } from 'undici'; // Or use native File if Node version supports it well for fetch

async function main() {
    const graphqlUrl = process.env.NEXT_PUBLIC_GRAPHQL_URL;
    const uploadFilePath = process.env.UPLOAD_FILE_PATH;
    const expectedUploadDir = process.env.EXPECTED_UPLOAD_DIR;

    if (!graphqlUrl || !uploadFilePath || !expectedUploadDir) {
        console.error('Missing required environment variables: NEXT_PUBLIC_GRAPHQL_URL, UPLOAD_FILE_PATH, EXPECTED_UPLOAD_DIR');
        process.exit(1);
    }

    const fileName = path.basename(uploadFilePath);
    let fileContent;

    try {
        fileContent = await fs.readFile(uploadFilePath);
    } catch (error) {
        console.error(`Failed to read upload file at ${uploadFilePath}:`, error);
        process.exit(1);
    }

    const operations = JSON.stringify({
        query: `
            mutation ($file: Upload!) {
                uploadFile(file: $file) {
                    fileName
                    mimeType
                    encoding
                    uri
                    fileSize
                }
            }
        `,
        variables: {
            file: null // This will be mapped to the file part in the FormData
        }
    });

    const formData = new FormData();
    formData.append('operations', operations);
    // The 'map' tells graphql-upload how to associate the file in the form data with the 'file' variable in the operations
    formData.append('map', JSON.stringify({ '0': ['variables.file'] }));
    // Create a File-like object for undici's FormData or native fetch
    const fileBlob = new UndiciFile([fileContent], fileName, { type: 'text/plain' });
    formData.append('0', fileBlob, fileName); // '0' corresponds to the key in the map

    let response;
    try {
        console.log(`Sending GraphQL multipart request to ${graphqlUrl} with file ${fileName}`);
        response = await fetch(graphqlUrl, {
            method: 'POST',
            body: formData,
            // `fetch` with `FormData` automatically sets the 'Content-Type' to 'multipart/form-data' with the correct boundary.
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`GraphQL request failed with status ${response.status}: ${errorText}`);
            process.exit(1);
        }

        const responseData = await response.json();
        console.log('GraphQL response:', JSON.stringify(responseData, null, 2));

        if (responseData.errors) {
            console.error('GraphQL errors:', responseData.errors);
            process.exit(1);
        }

        const uploadedFileData = responseData.data?.uploadFile;
        if (!uploadedFileData) {
            console.error('uploadFile data not found in response.');
            process.exit(1);
        }

        if (uploadedFileData.fileName !== fileName) {
            console.error(`Uploaded file name mismatch. Expected: ${fileName}, Got: ${uploadedFileData.fileName}`);
            process.exit(1);
        }

        // Verify file existence
        const expectedFilePath = path.join(expectedUploadDir, fileName);
        await fs.access(expectedFilePath); // Throws if file doesn't exist
        console.log(`File ${fileName} successfully uploaded and found at ${expectedFilePath}`);

        // Optional: Verify file content if necessary, though size might be sufficient for this test
        const stats = await fs.stat(expectedFilePath);
        if (stats.size !== fileContent.length) {
             console.error(`Uploaded file size mismatch. Expected: ${fileContent.length}, Got: ${stats.size}`);
             process.exit(1);
        }
        console.log(`File size verified: ${stats.size} bytes.`);


        console.log('Integration test passed!');
        process.exit(0);

    } catch (error) {
        console.error('Integration test failed:', error);
        if (response && !response.ok) {
            try {
                const errorBody = await response.text();
                console.error("Response body on error:", errorBody);
            } catch (e) {
                console.error("Could not get response body on error:", e);
            }
        }
        process.exit(1);
    }
}

main();
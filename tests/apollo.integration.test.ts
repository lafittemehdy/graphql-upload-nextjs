import { ApolloServer } from '@apollo/server'
import { expect, it } from 'vitest'
import { GraphQLUpload, uploadProcess } from '../src/index'

it('executes the selected multipart operation using real Apollo and Web Request objects', async () => {
    const server = new ApolloServer({
        typeDefs: 'scalar Upload type Query { hello: String } type Mutation { upload(file: Upload!): String! }',
        resolvers: {
            Upload: GraphQLUpload,
            Mutation: { upload: async (_: unknown, { file }: any) => (await file).filename },
        },
    })
    const body = new FormData()
    body.set('operations', JSON.stringify({
        query: 'mutation A($file: Upload!) { upload(file: $file) } mutation B($file: Upload!) { selected: upload(file: $file) }',
        operationName: 'B', variables: { file: null },
    }))
    body.set('map', JSON.stringify({ 0: ['variables.file'] }))
    body.set('0', new File(['hello'], 'test.txt', { type: 'text/plain' }))
    const request = new Request('http://localhost/graphql', {
        method: 'POST', body, headers: { 'Apollo-Require-Preflight': 'true' },
    })
    try {
        const response = await uploadProcess(request, {}, server)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ data: { selected: 'test.txt' } })
    } finally {
        await server.stop()
    }
})

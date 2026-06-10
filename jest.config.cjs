/** @type {import('jest').Config} */
module.exports = {
  moduleNameMapper: {
    '^file-type$': '<rootDir>/tests/mocks/file-type.cjs',
    '^istextorbinary$': '<rootDir>/tests/mocks/istextorbinary.cjs',
    '^next/server\\.js$': '<rootDir>/tests/mocks/next-server.cjs',
  },
  preset: 'ts-jest',
  roots: ['<rootDir>/tests'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  testEnvironment: 'node',
}

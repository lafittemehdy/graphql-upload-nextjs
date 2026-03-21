/** Mock for next/server.js module. */
module.exports = {
  NextResponse: {
    json(body, init) {
      return { body, status: (init && init.status) || 200 }
    },
  },
}

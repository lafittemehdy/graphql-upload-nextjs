export default function Home() {
  return (
    <main className="bg-black flex items-center justify-center min-h-screen p-8 text-white">
      <div className="max-w-4xl">
        <h1 className="mb-4 text-7xl font-extrabold tracking-tight uppercase">
          Example GraphQL Upload Next.js
        </h1>
        <p className="mb-8 text-2xl leading-relaxed">
          Seamlessly enable GraphQL multipart requests for file uploads in your
          Apollo Server Next.js integration.
        </p>
        <a
          className="block border border-white font-bold hover:bg-white hover:text-black px-8 py-4 text-center text-3xl transition-colors"
          href="/api/graphql"
        >
          GO TO GRAPHQL API
        </a>
      </div>
    </main>
  );
}

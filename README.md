# Interview Question API

A small Express + TypeScript API that uses Google Gemini to generate interview questions for a given job title.

## Features

- Generates exactly 10 interview questions for a supplied role
- Uses Gemini structured output with retry logic
- Sanitizes and validates incoming job titles
- Caches successful responses in memory for 10 minutes
- Applies rate limiting to `/api/*`
- Includes health check and consistent JSON error responses

## Stack

- Node.js
- TypeScript
- Express
- `@google/generative-ai`
- `node-cache`
- `express-rate-limit`

## Requirements

- Node.js 18+
- A Google Gemini API key

## Environment Variables

Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_gemini_api_key
PORT=5000
NODE_ENV=development
```

### Variables

- `GEMINI_API_KEY`: Required. Used to call Gemini.
- `PORT`: Optional. Defaults to `3000`.
- `NODE_ENV`: Optional. Defaults to `development`.

## Installation

Using `pnpm`:

```bash
pnpm install
```

Using `npm`:

```bash
npm install
```

## Running Locally

Start in development mode:

```bash
npm run dev
```

Build the project:

```bash
npm run build
```

Run the compiled server:

```bash
npm start
```

## Docker

Build the API image:

```bash
docker build -t interview-question-api .
```

Run it locally:

```bash
docker run --rm -p 3000:3000 \
  -e GEMINI_API_KEY=your_gemini_api_key \
  interview-question-api
```

Then check:

```bash
curl http://localhost:3000/health
```

## Deploying To Render With Docker

This API includes:

- [Dockerfile](/home/antodev/Desktop/interview/interviewQuestionApi/Dockerfile)
- [.dockerignore](/home/antodev/Desktop/interview/interviewQuestionApi/.dockerignore)
- [render.yaml](/home/antodev/Desktop/interview/interviewQuestionApi/render.yaml)

On Render:

1. Create a new Web Service from this repository.
2. Choose Docker as the runtime.
3. Set the Dockerfile path to `./Dockerfile`.
4. Add the `GEMINI_API_KEY` environment variable.
5. Deploy.

Render provides the `PORT` environment variable automatically, and the API reads it at startup.

## API

Base URL:

```text
http://localhost:5000
```

If you do not set `PORT`, use:

```text
http://localhost:3000
```

### `GET /health`

Returns basic server status.

Example response:

```json
{
  "status": "ok",
  "timestamp": "2026-05-18T10:00:00.000Z",
  "environment": "development"
}
```

### `POST /api/questions`

Generates 10 interview questions for a job title.

Request body:

```json
{
  "jobTitle": "Senior React Developer"
}
```

Successful response:

```json
{
  "success": true,
  "data": {
    "jobTitle": "Senior React Developer",
    "questions": [
      "How do you structure state management in a large React application?",
      "How do you approach performance optimization in React applications?",
      "How would you design reusable component APIs for a shared design system?",
      "How do you handle data fetching, caching, and synchronization in modern React apps?",
      "How do you test complex React components and hooks effectively?",
      "How do you manage accessibility requirements in a component-driven frontend?",
      "How would you approach migrating a legacy React codebase to modern patterns?",
      "How do you evaluate tradeoffs between server-side rendering and client-side rendering?",
      "How do you mentor junior frontend engineers while maintaining delivery speed?",
      "How do you debug production issues in large-scale React applications?"
    ]
  }
}
```

Cached response:

```json
{
  "success": true,
  "data": {
    "jobTitle": "Senior React Developer",
    "questions": [
      "..."
    ],
    "cached": true
  }
}
```

Validation error example:

```json
{
  "success": false,
  "error": {
    "code": "invalid job title",
    "message": "please provide a valid professional job title(2-100 character)"
  }
}
```

## Example Requests

Using `curl`:

```bash
curl -X POST http://localhost:5000/api/questions \
  -H "Content-Type: application/json" \
  -d '{"jobTitle":"Software Engineer"}'
```

Using the included HTTP file:

- Open [app.http](/home/antodev/Desktop/interview/interviewQuestionApi/app.http)
- Run the `GET /health` or `POST /api/questions` request from your editor

## Scripts

- `npm run dev`: Start the app in development mode with auto-reload
- `npm run build`: Compile TypeScript into `dist/`
- `npm start`: Run the compiled app

## Behavior Notes

- The API currently allows only `GET` and `POST` methods through CORS.
- Allowed CORS origins are hard-coded in the server:
  - `https://myfrontend.com`
  - `https://localhost:3000`
- Responses are cached in memory, so cache entries are lost when the server restarts.
- Rate limiting is applied to `/api/*` at 100 requests per 15 minutes per IP.

## Project Structure

```text
.
├── app.http
├── src
│   ├── index.ts
│   └── types
│       └── types.ts
├── dist
├── package.json
└── tsconfig.json
```

## Limitations

- There are currently no automated tests in this repository.
- Cache storage is in-memory only.
- The app depends on external Gemini availability and API quota.

# Meet React App

This is a separate Vite + React frontend that keeps the existing `frontend/` folder untouched.

## Environment Setup

Create a `.env` file in the `react-frontend/` directory with the following variables:

```env
VITE_BACKEND_URL=http://localhost:9000
VITE_API_KEY=your-api-key-here
```

See `.env.example` for the template.

## Run locally

1. Install dependencies: `npm install`
2. Create `.env` file with backend configuration
3. Start the dev server: `npm run dev`
4. Build for production: `npm run build`

## Features

- Clean two-screen flow: landing page → meeting page
- Left chat panel for real-time messaging
- Main video grid for participants
- Small self-view tile
- Bottom control dock (mute/video/camera/record/leave)
- Short invite modal for adding customers
- Light theme with yellow/black accents
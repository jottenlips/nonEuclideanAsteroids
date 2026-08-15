# Non-Euclidean Asteroids

A 3D Asteroids game built with React 360 (React VR) and three.js. The arena is a
wireframe sphere: the ship, asteroids, and bullets slide on the sphere surface
and wrap around its seams and poles.

The sphere is divided into four colored quadrants (NE cyan, NW green, SE orange,
SW magenta). Asteroids change color to match the quadrant they are currently in.

## Controls

| Key | Action |
| --- | --- |
| Arrow Left / A | Turn left |
| Arrow Right / D | Turn right |
| Arrow Up / W | Thrust |
| Space | Fire |
| R | Restart (after game over) |

Mouse: click and drag to orbit the camera around the ship. The camera hovers
above the ship and keeps it centered in view.

## Run locally

Requires Node 20 (the packager needs the OpenSSL legacy provider).

```sh
npm install
npm start
```

Then open http://localhost:8081/index.html

## Build production bundles

```sh
npm run bundle
```

This writes `client.bundle.js`, `index.bundle.js`, and a generated
`index.html` into `build/`.

## Deploy to GitHub Pages

The static site is served from the `docs/` folder on the `main` branch:

1. Build the bundles:
   ```sh
   npm run bundle
   ```
2. Copy the bundles and static assets into `docs/` (keep the ready-made
   `docs/index.html` from this repo):
   ```sh
   cp build/client.bundle.js build/index.bundle.js docs/
   cp -r static_assets docs/
   ```
3. Commit and push `docs/` to the `main` branch:
   ```sh
   git add docs
   git commit -m "Update static build"
   git push origin main
   ```
4. On GitHub, go to Settings, then Pages, and set Source to "Deploy from a
   branch" with branch `main` and folder `/docs`. The game will be live at
   `https://<user>.github.io/<repo>/`.

All asset paths in `docs/index.html` are relative, so the game works when the
site is served from the repository subpath.

### Auto deploy

A GitHub Action at `.github/workflows/deploy.yml` rebuilds the production
bundles and updates `docs/` automatically on every push to `main`, so you only
need to push your source changes. The manual copy steps above are only needed
if you want to update the deployed site without pushing source code.


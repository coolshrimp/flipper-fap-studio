# Publishing Flipper FAP Studio

How to release a new version to GitHub and the VS Code Marketplace.

## One-time setup (Marketplace)

1. Create a **publisher** (id `coolshrimp` must match `publisher` in package.json):
   https://marketplace.visualstudio.com/manage — sign in with a Microsoft account.
2. Create a **Personal Access Token** in Azure DevOps (https://dev.azure.com):
   - User settings → Personal Access Tokens → New Token
   - Organization: **All accessible organizations**
   - Scope: **Marketplace → Manage**
3. Log in once from this folder:
   ```
   npx vsce login coolshrimp
   ```
   Paste the token when asked.

## Every release

1. Bump `version` in [package.json](package.json) and add a section to [CHANGELOG.md](CHANGELOG.md).
2. Build and package (compile runs automatically via `vscode:prepublish`):
   ```
   npx vsce package
   ```
3. Test the generated `.vsix` locally: `Ctrl+Shift+P` → **Extensions: Install from VSIX**.
4. Publish:
   ```
   npx vsce publish
   ```
   (or upload the `.vsix` manually at https://marketplace.visualstudio.com/manage)
5. Commit, tag, and push:
   ```
   git add -A
   git commit -m "Release vX.Y.Z"
   git tag vX.Y.Z
   git push --follow-tags
   ```
6. Optionally attach the `.vsix` to a GitHub Release for users who install manually.

## Notes

- The Marketplace icon is `media/icon.png` (512×512, resized from `media/FAP Studio Color Icon.png`;
  regenerate with `magick "media/FAP Studio Color Icon.png" -resize 512x512 media/icon.png`).
- `.vscodeignore` controls what goes inside the `.vsix` — source, docs, and this file are excluded.
- Marketplace listing renders `README.md`; keep screenshots/links there current.

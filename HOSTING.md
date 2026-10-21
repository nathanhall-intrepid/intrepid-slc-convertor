# Share Layer Studio through GitHub Pages

GitHub Pages can serve this app directly from a repository. After deployment, users open an HTTPS link in their browser. They do not need Node.js, the Windows launcher, or an open command window, and your computer does not need to stay on. GitHub Pages hosts static HTML, CSS, and JavaScript. [GitHub Pages overview](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

## Publish the app

1. Use the repository name `intrepid-slc-convertor` for **Intrepid SLC Convertor**. Put this project's contents at the repository root, on the `main` branch. In particular, the repository must contain `.github/workflows/pages.yml` and `dist/index.html` at those exact paths. Keep personal STL files, resin recipes, and other private working files outside the repository.
2. Open the repository's **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**. The prepared workflow already supplies the deployment configuration; no additional template is needed. [GitHub's publishing-source instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
3. In **Actions**, select **Deploy Layer Studio to GitHub Pages**, then **Run workflow** on `main`. Subsequent pushes to `main` also run it. A first run that happened before Pages was enabled can be rerun after completing step 2.
4. Wait for both **Prepare static app** and **Publish app** to succeed. Open the deployment URL shown on the workflow or in **Settings → Pages**. The expected default address is `https://OWNER.github.io/intrepid-slc-convertor/`, where `OWNER` is your GitHub account or organization. Share the actual deployed app address; the repository address displays source code. [GitHub Pages URL conventions](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

GitHub Free supports Pages from public repositories. Availability for private repositories depends on the account or organization plan. A private repository does not by itself make its Pages website private. [Availability and visibility](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## What the workflow does

The workflow uploads only `dist/`, which already contains the app, geometry worker, vendored Three.js, styles, icon, and user guide. There is no package installation or compilation step. Relative module and asset paths preserve operation under the project subpath `/intrepid-slc-convertor/`.

The preparation job has read access to repository contents and Pages configuration. Only the deployment job receives `pages: write` and `id-token: write`. It deploys through the `github-pages` environment using GitHub's official actions. No personal access token or stored deployment secret is required. The workflow runs only from `main`, has ten-minute job timeouts, and serializes deployments. [Official custom-workflow requirements](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

## Check the first deployment

Open the published URL in a current browser, confirm that the demo loads, and run a scan. Try a local STL, switch views, add a manual section, then download an SLC and companion recipe. This verifies the hosted app and worker load correctly; printer compatibility still needs the normal import and hardware checks.

If the workflow cannot find the Pages site, check the publishing source in step 2 and your repository permissions. If the website returns 404, use the actual URL shown by the successful deployment and ensure `dist/index.html` was included in the upload. Organization policies can also restrict Actions or Pages.

STL processing still happens in each visitor's browser. The app does not upload selected models to GitHub. Profiles remain in that browser, and sharing the app URL does not share loaded geometry, profiles, or settings. Localhost and the hosted website have separate browser storage; use a downloaded recipe to transfer settings when needed.

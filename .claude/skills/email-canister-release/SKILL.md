---
name: email-canister-release
description: Prepare and publish an email-canister release (version.txt, release notes, reproducible build, release workflow). Use when asked to make, cut or publish a release or release candidate.
---

# Releasing email-canister

Follow `README-Release-Guide.md` step by step. In addition:

1. Ask for the version number if the user did not give one. Propose one from the changes since the last tag (`git describe --tags --abbrev=0`, then `git log <tag>..HEAD`).
2. Write the release notes from the commits and the diff of `src/email-canister.did`. Fill every section of the template; "None" where nothing changed.
3. Run `scripts/check-neutral.sh` and read the release notes for indirect references to any deployment, person or reference project. The notes describe the product only.
4. Do not build locally: CI's build is the one the notes cite, and the release workflow builds again to check it. Push the branch to this repository (not a fork) as `release/vX.Y.Z` and open the pull request. CI's `reproducible-build` job builds the wasm and the webmail in Docker, prints their hashes in its log (`gh run view <run id> --log --job <job id>`, step "hashes") and its run summary, and packs the zip, listing its files in the job log. Put those hashes in the upgrade notes. A later commit that changes the code or the webmail changes them, and so does a change merged to main meanwhile: then update the branch from main and take the hashes again from the new run.
5. Check the zip's file list in that job's log against what `scripts/make-release-zip.sh` packs, and report anything missing or unexpected.
6. The pull request needs the reviews listed in the README's Contributing section before it is merged. Then run `/claude-security` "Scan changes" on the PR at high effort, and fix its findings like the other reviews'. Do not merge it yourself unless the user says so.
7. Start the release workflow only when the user says to, and only once the `cicd` run on the merge commit in `main` has passed: started before then, the workflow stops at its check that CI passed and publishes nothing. Find that run with `gh run list --workflow cicd.yml --branch main --event push --commit <merge sha>`, wait for it with `gh run watch`, then run `gh workflow run release.yml -f tag=vX.Y.Z`. Then watch it with `gh run watch`, and report the release URL and the wasm sha256. Its build is the second, independent one: the workflow refuses to publish when the release notes do not name the wasm sha256 and the webmail `dist` hash it built. Stop and report if it does.
8. Update the deployments the user maintains, after the release is published. Ask which ones, unless the user keeps a list outside this repo in `~/.config/email-canister/deployments`: blank lines and lines starting with `#` are skipped, and every other line names one deployment as a `<Caffeine app repo> <deployment repo>` pair separated by spaces, both folders next to this repo. If that file exists but lists no deployment, or a line is not such a pair, say so and stop. Update the test deployment first. For each deployment:
   - First read the release's upgrade notes: they decide which of the backend, the webmail and the bridge are redeployed, and in which order. Where they say the backend is unchanged, deploy only the webmail, even if the deployment repository's README deploys both: a backend deploy stops the canister.
   - Update the deployment repository as its own README says, on a branch with that repository's reviews. Deploy as the identity its `.icp-identity` file names, and only after the user confirms each mainnet deploy.
   - When the release changes `bridge/`, the Caffeine app gets the new files as `bridge/README.md` describes, keeping its `relayCaller`, on a branch with the app repository's reviews. Once that branch is merged, run the deployment repository's bridge check, if it has one, and ask the user to deploy the app only once it passes.
   - After the deploys, run the deployment repository's check, or `scripts/check.sh --backend <backend id> --domain <domain> --wasm-sha256 <hash>`, where the hash is the wasm the backend should now run: the release's, or the previous one where the backend was not redeployed.

   Report a deployment as done only once every deploy it needed is confirmed, the app's included. Never write a deployment's name into this repo: it stays neutral.

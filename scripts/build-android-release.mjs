#!/usr/bin/env node
// Thin CLI entry for the production Android release build. All logic lives in
// scripts/lib/release-android.mjs; main() returns the exit code for testability.
import { main } from './lib/release-android.mjs'

process.exitCode = main(process.argv.slice(2))

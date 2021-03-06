#!/usr/bin/env node
require('machine-as-script')({


  friendlyName: 'kit install',


  description: 'Install the verified/trusted release of a dependency, then save it to the package.json file.',


  inputs: {

    dev: {
      description: 'Whether to save this as a dev dependency.',
      example: false
    },

    verifiedReleases: {
      description: 'A dictionary mapping package names of common dependencies to the version string of a verified release.',
      extendedDescription:
      'On the Sails.js team, we prefer to pin the versions of 3rd party dependencies \n'+
      'from outside of the project, just because we\'ve been burned on more than one occasion \n'+
      'by patch or minor releases breaking functionality.  But while pinning depenency versions \n'+
      'is great for maintainability, security, and stability, it does have the effect of defeating \n'+
      'a powerful, built-in download size optimization in NPM. \n'+
      '\n'+
      'So, for certain *common* dependencies, like async and lodash, we\'re moving towards \n'+
      'standardizing the pinned version number across all of our modules.  This reduces overall \n'+
      '`npm install` time, makes for a more optimized bundle when browserifying, and, in general, \n'+
      'makes packages easier to understand and troubleshoot. \n'+
      '\n'+
      'This is a dictionary of those "verified" versions for *common deps*. \n'+
      '',
      example: {},
      defaultsTo: require('rodestead').verifiedReleases
    },

    trustedReleases: {
      // Note that, for these, loose semver ranges will be tolerated as long as they match the specified semver range.
      description: 'A set of trusted semver ranges of internal and/or core packages.',
      extendedDescription:
      'There are also certain dependencies which our team directly maintains.\n'+
      '\n'+
      'Since we have the direct ability to publish patches, we are ultimately responsible for\n'+
      'ensuring that those dependencies use proper semantic versioning.  In an effort to keep\n'+
      'us honest and make sure that we only break features on major version bumps, we use loose\n'+
      'semver ranges for our internal dependencies as much as possible.\n'+
      '\n'+
      'This is not by any means a complete list-- it just has a few of the most commonly-used\n'+
      'packages that we maintain.  It will be expanded over time.\n'+
      '',
      example: {},
      defaultsTo: require('rodestead').trustedSemverRanges,
    }

  },


  exits: {

    notAnNpmPackage: {
      description: 'This is not an NPM package.'
    }

  },


  fn: function (inputs, exits, env) {
    var path = require('path');
    var _ = require('lodash');
    var chalk = require('chalk');
    var async = require('async');
    var Filesystem = require('machinepack-fs');
    var NPM = require('machinepack-npm');


    // A dictionary mapping the package names of common dependencies to the version number of a verified release.
    var VERIFIED_RELEASES_OF_COMMON_DEPS = inputs.verifiedReleases;

    // A set of trusted package names.
    // (loose semver ranges will be tolerated, as long as they are compatible with the specified semver range.)
    var TRUSTED_RELEASES_OF_CORE_DEPS = inputs.trustedReleases;


    // --•
    // If we made it here, we're dealing with a common or core dependency.
    Filesystem.readJson({
      source: path.resolve('package.json'),
      schema: {},
    }).exec({
      // An unexpected error occurred.
      error: function(err) {
        return exits.error(err);
      },
      // No file exists at the provided `source` path
      doesNotExist: function(err) {
        return exits.notAnNpmPackage(err);
      },
      // Could not parse file as JSON.
      couldNotParse: function(err) {
        return exits.notAnNpmPackage(err);
      },
      // OK.
      success: function(destPkgMD) {

        var depsToInstall;

        // If serial command-line arguments were specified, use them.
        if (env.serialCommandLineArgs.length > 0) {
          depsToInstall = _.map(env.serialCommandLineArgs, function (pkgName){
            return {
              name: pkgName,
              kind: inputs.dev ? 'dev' : ''
            };
          });
        }
        // Otherwise use the existing dependencies and dev dependencies of this package.
        // (in this case, the `--dev` flag should never be used)
        else {
          if (!_.isUndefined(inputs.dev)) {
            return exits.error(new Error('The `dev` option should only be used when also specifying NEW dependencies to install.'));
          }

          depsToInstall = [];
          _.each(destPkgMD.dependencies, function (semverRange, pkgName){
            depsToInstall.push({ name: pkgName, kind: '' });
          });
          _.each(destPkgMD.devDependencies, function (semverRange, pkgName){
            depsToInstall.push({ name: pkgName, kind: 'dev' });
          });
        }

        // Keep track of things we install below.
        var thingsInstalled = [];

        // Now install all deps.
        async.eachLimit(depsToInstall, 5, function (depInfo, done){

          try {

            // Set up local variable for pkg name to install.
            var nameOfPkgToInstall = depInfo.name;

            // Check if the specified package is in list of common dependencies.
            var verifiedVersion = VERIFIED_RELEASES_OF_COMMON_DEPS[nameOfPkgToInstall];
            var isCommon = !_.isUndefined(verifiedVersion);

            // Check if the specified package is in list of core dependencies.
            var trustedSemverRange = TRUSTED_RELEASES_OF_CORE_DEPS[nameOfPkgToInstall];
            var isCore = !_.isUndefined(trustedSemverRange);


            // Check to see if dep is already there.
            // (check deps AND devDeps... but not optionalDeps because we never use that)
            var depSemverRange;
            if (destPkgMD.dependencies) {
              depSemverRange = destPkgMD.dependencies[nameOfPkgToInstall];
            }
            var devDepSemverRange;
            if (destPkgMD.devDependencies) {
              devDepSemverRange = destPkgMD.devDependencies[nameOfPkgToInstall];
            }
            var relevantExistingSemverRange = !_.isUndefined(depSemverRange) ? depSemverRange : devDepSemverRange;

            // If so, then it may still be overridden, or we might still bail early.

            // Under a few circumstances, we'll bail now w/ an error msg:
            // (or if it is in there BUT WRONG, then log a slightly different message)
            if (depInfo.kind === 'dev' && !_.isUndefined(depSemverRange)) {
              return done(new Error(nameOfPkgToInstall + ' is already in the package.json file, but as a normal (non-dev) dependency! ('+depSemverRange+').'));
            }
            else if (depInfo.kind === '' && !_.isUndefined(devDepSemverRange)) {
              return done(new Error(nameOfPkgToInstall + ' is already in the package.json file, but as a dev dependency! ('+devDepSemverRange+').'));
            }
            else if (!_.isUndefined(depSemverRange) || !_.isUndefined(devDepSemverRange)) {

              if (isCommon) {
                if (relevantExistingSemverRange !== verifiedVersion) {
                  console.log(chalk.bold.yellow(nameOfPkgToInstall) + ' is already in the package.json file.');
                  console.log(chalk.gray(' But the existing semver range (`'+relevantExistingSemverRange+'`) isn\'t quite right.  Should instead be pinned to '+verifiedVersion+'.  Proceeding to install and save...'));
                  console.log(chalk.gray(' Proceeding to install and save...'));
                }
                else {
                  console.log(
                    chalk.bold.cyan(nameOfPkgToInstall) + ' is already in the package.json file.' +
                    chalk.gray('  ✓ Skipping... b/c it is already pinned to a verified version.')
                  );
                  return done();
                }
              }
              else if (isCore) {
                // TODO: add this kind of check at some point:
                // var isCompatible = NPM.isVersionCompatible({ version: dependencyPkgMD.version, semverRange: trustedSemverRange }).execSync() :
                // if (!isCompatible) {
                //   console.log('But the existing semver range (`'+relevantExistingSemverRange+'`) isn\'t quite right.');
                //   console.log('Should instead be within: '+trustedSemverRange);
                // }
                // else {
                console.log(
                  chalk.bold.cyan(nameOfPkgToInstall) + ' is already in the package.json file.' +
                  chalk.gray('  ✓ Skipping... b/c it is a core dep within a trusted range.')
                );
                return done();
                // }
              }
              // Otherwise, it's neither:
              else {

                try {
                  NPM.validateVersion({ string: relevantExistingSemverRange, strict: true }).execSync();

                  // --• If it is valid, then bail early-- we don't need to do anything else.
                  console.log(
                    chalk.bold.cyan(nameOfPkgToInstall) + ' is already in the package.json file.' +
                    chalk.gray('  ✓ Skipping... b/c it is pinned.')
                  );
                  return done();

                } catch (e) {
                  switch (e.exit) {
                    // If the relevant existing semver range is not a valid version,
                    // that means it is NOT pinned.  Since it is not pinned, then we need
                    // to reinstall it, but pinned.
                    case 'invalidSemanticVersion':
                      console.log(chalk.bold.yellow(nameOfPkgToInstall) + ' is already in the package.json file.');
                      console.log(chalk.gray(' The specified dependency (`'+nameOfPkgToInstall+'`) is not a known common or core dependency.  (See `verifiedReleases` & `trustedReleases`.)'));
                      console.log(chalk.gray(' Proceeding to install the latest release that matches this semver range (`'+relevantExistingSemverRange+'`), and then pin it in the package.json file...'));
                      break;
                    default: throw e;
                  }
                }
              }//</else: misc dep>

            }//</already exists in package.json in either the deps or devDeps>
            else {
              console.log('Will install new dep ('+chalk.bold.yellow(nameOfPkgToInstall) + ') and pin it in the package.json file.');
            }

            // >-•

            // Detemine which version or semver range to install.
            var relevantVersionOrSemverRangeToInstall;
            if (isCommon) { relevantVersionOrSemverRangeToInstall = verifiedVersion; }
            else if (isCore) { relevantVersionOrSemverRangeToInstall = trustedSemverRange; }
            else {
              if (_.isUndefined(relevantExistingSemverRange)) {
                relevantVersionOrSemverRangeToInstall = '*';
              }
              else {
                relevantVersionOrSemverRangeToInstall = relevantExistingSemverRange;
              }
            }
            // >-

            if (!relevantVersionOrSemverRangeToInstall) {
              throw new Error('Consistency violation: Internal error!  Would have attempted to install crazy semver range or version: `'+relevantVersionOrSemverRangeToInstall+'`');
            }

            // Install a package from the NPM registry to the `node_modules/` folder of this project,
            // and update the package.json file.
            NPM.installPackage({
              name: nameOfPkgToInstall,
              version: relevantVersionOrSemverRangeToInstall,
              dir: process.cwd(),
              save: depInfo.kind !== 'dev',
              saveDev: depInfo.kind === 'dev',
              saveExact: true,
              loglevel: 'warn',
            }).exec(function (err) {
              if (err) { return done(err); }

              // Track this as installed.
              thingsInstalled.push(nameOfPkgToInstall);

              return done();
            });//</NPM.installPackage>
          } catch (e) { return done(e); }
        }, function (err) {
          if (err) { return exits.error(err); }

          if (thingsInstalled.length > 0) {
            console.log();
            console.log(chalk.green('✓')+' Updated '+thingsInstalled.length+' dependenc'+(thingsInstalled.length !== 1 ? 'ies' : 'y')+'.');
          }

          return exits.success();

        });//</async.each()>
      }//—————— on success —————¬
    });//</Filesystem.readJson()>
  }

}).exec();

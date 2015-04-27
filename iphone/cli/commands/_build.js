/**
 * iOS build command.
 *
 * @module cli/_build
 *
 * @copyright
 * Copyright (c) 2009-2014 by Appcelerator, Inc. All Rights Reserved.
 *
 * @license
 * Licensed under the terms of the Apache Public License
 * Please see the LICENSE included with this distribution for details.
 */

var appc = require('node-appc'),
	async = require('async'),
	Builder = require('titanium-sdk/lib/builder'),
	cleanCSS = require('clean-css'),
	ejs = require('ejs'),
	fields = require('fields'),
	fs = require('fs'),
	humanize = require('humanize'),
	ioslib = require('ioslib'),
	iosPackageJson = appc.pkginfo.package(module),
	jsanalyze = require('titanium-sdk/lib/jsanalyze'),
	moment = require('moment'),
	path = require('path'),
	spawn = require('child_process').spawn,
	ti = require('titanium-sdk'),
	util = require('util'),
	uuid = require('node-uuid'),
	wrench = require('wrench'),
	__ = appc.i18n(__dirname).__,
	parallel = appc.async.parallel,
	series = appc.async.series,
	version = appc.version;

function iOSBuilder() {
	Builder.apply(this, arguments);

	this.minSupportedIosSdk = parseInt(version.parseMin(this.packageJson.vendorDependencies['ios sdk']));
	this.maxSupportedIosSdk = parseInt(version.parseMax(this.packageJson.vendorDependencies['ios sdk']));

	this.deployTypes = {
		'simulator': 'development',
		'device': 'test',
		'dist-appstore': 'production',
		'dist-adhoc': 'production'
	};

	this.targets = ['simulator', 'device', 'dist-appstore', 'dist-adhoc'];

	this.deviceFamilies = {
		iphone: '1',
		ipad: '2',
		universal: '1,2'
	};

	// populated the first time getDeviceFamily() is called
	this.deviceFamily = null;

	this.deviceFamilyNames = {
		iphone: ['ios', 'iphone'],
		ipad: ['ios', 'ipad'],
		universal: ['ios', 'iphone', 'ipad']
	};

	this.xcodeTargetSuffixes = {
		iphone: '',
		ipad: '-iPad',
		universal: '-universal'
	};

	this.simTypes = {
		iphone: 'iPhone',
		ipad: 'iPad'
	};

	this.blacklistDirectories = [
		'contents',
		'resources'
	];

	this.graylistDirectories = [
		'frameworks',
		'plugins'
	];

	this.ipadSplashImages = [
		'Default-Landscape.png',
		'Default-Landscape@2x.png',
		'Default-Portrait.png',
		'Default-Portrait@2x.png',
		'Default-LandscapeLeft.png',
		'Default-LandscapeLeft@2x.png',
		'Default-LandscapeRight.png',
		'Default-LandscapeRight@2x.png',
		'Default-PortraitUpsideDown.png',
		'Default-PortraitUpsideDown@2x.png'
	];

	this.tiSymbols = {};
	this.useJSCore=false;

	// populated when config() is called after iOS info has been detected
	this.defaultIosVersion = null;

	// populated the first time getDeviceInfo() is called
	this.deviceInfoCache = null;
}

util.inherits(iOSBuilder, Builder);

iOSBuilder.prototype.assertIssue = function assertIssue(issues, name) {
	var i = 0,
		len = issues.length;
	for (; i < len; i++) {
		if ((typeof name === 'string' && issues[i].id === name) || (typeof name === 'object' && name.test(issues[i].id))) {
			this.logger.banner();
			appc.string.wrap(issues[i].message, this.config.get('cli.width', 100)).split('\n').forEach(function (line, i, arr) {
				this.logger.error(line.replace(/(__(.+?)__)/g, '$2'.bold));
				if (!i && arr.length > 1) this.logger.log();
			}, this);
			this.logger.log();
			process.exit(1);
		}
	}
};

iOSBuilder.prototype.getDeviceInfo = function getDeviceInfo() {
	if (this.deviceInfoCache) {
		return this.deviceInfoCache;
	}

	var argv = this.cli.argv,
		deviceInfo = {
			devices: [],
			udids: {},
			maxName: 0,
			preferred: null
		};

	if (argv.target === 'device') {
		// build the list of devices
		this.iosInfo.devices.forEach(function (device) {
			device.name.length > deviceInfo.maxName && (deviceInfo.maxName = device.name.length);
			deviceInfo.devices.push({
				udid: device.udid,
				name: device.name,
				deviceClass: device.deviceClass,
				productVersion: device.productVersion
			});
			deviceInfo.udids[device.udid] = device;
		});

		if (this.config.get('ios.autoSelectDevice', true) && !argv['device-id']) {
			deviceInfo.preferred = deviceInfo.devices[0];
		}
	} else if (argv.target === 'simulator') {
		deviceInfo.devices = {};

		// check if they specified the legacy settings: --sim-version, --sim-type, --retina, --tall, --sim-64bit
		if (this.config.get('ios.autoSelectDevice', true) && (argv['sim-version'] || argv['sim-type'] || argv.retina || argv.tall || argv['sim-64bit'])) {
			// try to find the closest matching simulator
			var version = argv['sim-version'] || argv['ios-version'] || this.defaultIosVersion,
				sims = this.iosInfo.simulators,
				candidates = {};

			// find all candidate simulators
			Object.keys(sims).forEach(function (ver) {
				if (!argv['sim-version'] || ver === argv['sim-version']) {
					sims[ver].forEach(function (sim) {
						if ((!argv['sim-type'] || sim.type === argv['sim-type']) && (!argv.retina || sim.retina) && (!argv.tall || sim.tall) && (!argv['sim-64bit'] || sim['64bit'])) {
							candidates[ver] || (candidates[ver] = []);
							candidates[ver].push(sim);
						}
					});
				}
			});

			// sort the candidates by iOS version, but put the preferred iOS version first
			// then find the preferred simulator, if any
			var simVers = Object.keys(candidates).sort(function (a, b) { return a === version ? -1 : 1; }),
				first, firstRetina;

			for (var i = 0, l = simVers.length; i < l; i++) {
				var simVer = simVers[i];
				for (var j = 0, k = candidates[simVer].length; j < k; j++) {
					if (!first) {
						first = candidates[simVer][j];
					}
					if (!firstRetina && candidates[simVer][j].retina) {
						firstRetina = candidates[simVer][j];
					}
					if (candidates[simVer][j].tall) {
						deviceInfo.preferred = candidates[simVer][j];
						i = l;
						break;
					}
				}
			}

			if (!deviceInfo.preferred) {
				deviceInfo.preferred = firstRetina || first;
			}
		}

		// build the list of simulators
		Object.keys(this.iosInfo.simulators).sort().reverse().forEach(function (ver) {
			deviceInfo.devices[ver] || (deviceInfo.devices[ver] = []);
			this.iosInfo.simulators[ver].forEach(function (sim) {
				sim.name.length > deviceInfo.maxName && (deviceInfo.maxName = sim.name.length);
				deviceInfo.devices[ver].push({
					udid: sim.udid,
					name: sim.name,
					deviceClass: sim.type,
					productVersion: ver,
					retina: sim.retina,
					tall: sim.tall,
					'64bit': sim['64bit']
				});
				deviceInfo.udids[sim.udid] = sim;
			});
		}, this);
	}

	return this.deviceInfoCache = deviceInfo;
};

iOSBuilder.prototype.getDeviceFamily = function getDeviceFamily() {
	if (this.deviceFamily) {
		return deviceFamily;
	}

	var deviceFamily = this.cli.argv['device-family'],
		deploymentTargets = this.cli.tiapp && this.cli.tiapp['deployment-targets'];

	if (!deviceFamily && process.env.TARGETED_DEVICE_FAMILY) {
		// device family was not specified at the command line, but we did get it via an environment variable!
		deviceFamily = process.env.TARGETED_DEVICE_FAMILY === '1' ? 'iphone' : process.env.TARGETED_DEVICE_FAMILY === '2' ? 'ipad' : 'universal';
	}

	if (!deviceFamily && deploymentTargets) {
		// device family was not an environment variable, construct via the tiapp.xml's deployment targets
		if (deploymentTargets.iphone && deploymentTargets.ipad) {
			deviceFamily = this.cli.argv.$originalPlatform === 'ipad' ? 'ipad' : 'universal';
		} else if (deploymentTargets.iphone) {
			deviceFamily = 'iphone';
		} else if (deploymentTargets.ipad) {
			deviceFamily = 'ipad';
		}
	}

	return this.deviceFamily = deviceFamily;
};

/**
 * Returns iOS build-specific configuration options.
 * @param {Object} logger - The logger instance
 * @param {Object} config - The CLI config
 * @param {Object} cli - The CLI instance
 * @returns {Function|undefined} A function that returns the config info or undefined
 */
iOSBuilder.prototype.config = function config(logger, config, cli) {
	Builder.prototype.config.apply(this, arguments);

	var _t = this;

	this.ignoreDirs = new RegExp(config.get('cli.ignoreDirs'));
	this.ignoreFiles = new RegExp(config.get('cli.ignoreFiles'));

	// we hook into the pre-validate event so that we can stop the build before
	// prompting if we know the build is going to fail.
	cli.on('cli:pre-validate', function (obj, callback) {
		if (cli.argv.platform && !/^(ios|iphone|ipad)$/i.test(cli.argv.platform)) {
			return callback();
		}

		// check that the iOS environment is found and sane
		this.assertIssue(this.iosInfo.issues, 'IOS_XCODE_NOT_INSTALLED');
		this.assertIssue(this.iosInfo.issues, 'IOS_NO_SUPPORTED_XCODE_FOUND');
		this.assertIssue(this.iosInfo.issues, 'IOS_NO_IOS_SDKS');
		this.assertIssue(this.iosInfo.issues, 'IOS_NO_IOS_SIMS');

		callback();
	}.bind(this));

	return function (done) {
		ioslib.detect({
			// env
			xcodeSelect: config.get('osx.executables.xcodeSelect'),
			security: config.get('osx.executables.security'),
			// provisioning
			profileDir: config.get('ios.profileDir'),
			// xcode
			searchPath: config.get('paths.xcode'),
			minIosVersion: iosPackageJson.minIosVersion,
			supportedVersions: iosPackageJson.vendorDependencies.xcode
		}, function (err, iosInfo) {
			this.iosInfo = iosInfo;

			// add itunes sync
			iosInfo.devices.push({
				udid: 'itunes',
				name: 'iTunes Sync'
			});

			// we have more than 1 device plus itunes, so we should show 'all'
			if (iosInfo.devices.length > 2) {
				iosInfo.devices.push({
					udid: 'all',
					name: 'All Devices'
				});
			}

			// get the all installed iOS SDKs and Simulators across all Xcode versions
			var allSdkVersions = {},
				sdkVersions = {},
				simVersions = {};
			Object.keys(iosInfo.xcode).forEach(function (ver) {
				if (iosInfo.xcode[ver].supported) {
					iosInfo.xcode[ver].sdks.forEach(function (sdk) {
						allSdkVersions[sdk] = 1;
						if (version.gte(sdk, this.minSupportedIosSdk)) {
							sdkVersions[sdk] = 1;
						}
					}, this);
					iosInfo.xcode[ver].sims.forEach(function (sim) {
						simVersions[sim] = 1;
					});
				}
			}, this);
			allSdkVersions = this.iosAllSdkVersions = version.sort(Object.keys(allSdkVersions));
			sdkVersions = this.iosSdkVersions = version.sort(Object.keys(sdkVersions));
			simVersions = this.iosSimVersions = version.sort(Object.keys(simVersions));

			// if we're running from Xcode, determine the default --ios-version
			var defaultIosVersion = null;
			if (iosInfo.selectedXcode && iosInfo.selectedXcode.supported) {
				defaultIosVersion = iosInfo.selectedXcode.sdks.sort().reverse()[0];
			}
			// if we didn't have a selected xcode, then just take the latest sdk from the latest xcode
			if (!defaultIosVersion) {
				Object.keys(iosInfo.xcode).filter(function (ver) {
					return iosInfo.xcode[ver].supported;
				}).sort().reverse().forEach(function (ver) {
					if (!defaultIosVersion && iosInfo.xcode[ver].sdks.length) {
						defaultIosVersion = iosInfo.xcode[ver].sdks[0];
					}
				});
			}
			this.defaultIosVersion = defaultIosVersion;

			var sdkRoot = process.env.SDKROOT || process.env.SDK_DIR;
			if (sdkRoot) {
				var m = sdkRoot.match(/\/iphone(?:os|simulator)(\d.\d).sdk/i);
				if (m) {
					defaultIosVersion = m[1];
					var file = path.join(sdkRoot, 'System', 'Library', 'CoreServices', 'SystemVersion.plist');
					if (fs.existsSync(file)) {
						var p = new appc.plist(file);
						if (p.ProductVersion) {
							defaultIosVersion = this.defaultIosVersion = p.ProductVersion;
						}
					}
				}
			}

			// create the lookup maps for validating developer/distribution certs from the cli args
			var developerCertLookup = {},
				distributionCertLookup = {};
			Object.keys(iosInfo.certs.keychains).forEach(function (keychain) {
				(iosInfo.certs.keychains[keychain].developer || []).forEach(function (d) {
					if (!d.invalid) {
						developerCertLookup[d.name.toLowerCase()] = d.name;
					}
				});

				(iosInfo.certs.keychains[keychain].distribution || []).forEach(function (d) {
					if (!d.invalid) {
						distributionCertLookup[d.name.toLowerCase()] = d.name;
					}
				});
			});

			var provisioningProfileLookup = {};

			cli.createHook('build.ios.config', function (callback) {
				callback(null, {
					flags: {
						'force-copy': {
							desc: __('forces files to be copied instead of symlinked for %s builds only', 'simulator'.cyan)
						},
						'force-copy-all': {
							desc: __('identical to the %s flag, except this will also copy the %s libTiCore.a file', '--force-copy',
								humanize.filesize(fs.statSync(path.join(_t.platformPath, 'libTiCore.a')).size, 1024, 1).toUpperCase().cyan)
						},
						'retina': {
							desc: __('use the retina version of the iOS Simulator')
						},
						'sim-64bit': {
							desc: __('use the 64-bit version of the iOS Simulator')
						},
						'sim-focus': {
							default: true,
							desc: __('focus the iOS Simulator')
						},
						'tall': {
							desc: __('in combination with %s flag, start the tall version of the retina device', '--retina'.cyan)
						},
						'xcode': {
							// secret flag to perform Xcode pre-compile build step
							hidden: true
						}
					},
					options: {
						'build-type': {
								hidden: true
							},
						'debug-host': {
							hidden: true
						},
						'deploy-type': {
							abbr: 'D',
							desc: __('the type of deployment; only used when target is %s or %s', 'simulator'.cyan, 'device'.cyan),
							hint: __('type'),
							order: 100,
							values: ['test', 'development']
						},
						'device-id': {
							abbr: 'C',
							desc: __('the udid of the iOS simulator or iOS device to install the application to; for %s builds %s',
								'device'.cyan, ('[' + 'itunes'.bold + ', <udid>, all]').grey),
							hint: __('udid'),
							order: 210,
							helpNoPrompt: function (logger, msg) {
								// if prompting is disabled and there's a problem, then help will use this function to display details
								logger.error(msg);
								var info = _t.getDeviceInfo();
								if (info.devices) {
									if (cli.argv.target === 'device') {
										logger.log('\n' + __('Available iOS Devices:'));
										info.devices.forEach(function (sim) {
											logger.log('  ' + (info.devices.length > 1 ? appc.string.rpad(sim.udid, 40) : sim.udid).cyan + '  ' + sim.name);
										});
										logger.log();
									} else {
										logger.log('\n' + __('Available iOS Simulators:'));
										Object.keys(info.devices).forEach(function (ver) {
											logger.log(String(ver).grey);
											info.devices[ver].forEach(function (sim) {
												logger.log('  ' + sim.udid.cyan + '  ' + sim.name);
											});
											logger.log();
										});
									}
								}
							},
							prompt: function (callback) {
								var info = _t.getDeviceInfo();
								if (info.preferred) {
									cli.argv['device-id'] = info.preferred.udid;
									return callback();
								}

								var options = {};

								// build a filtered list of simulators based on any legacy options/flags
								if (Array.isArray(info.devices)) {
									options = info.devices;
								} else {
									Object.keys(info.devices).forEach(function (sdk) {
										if (!cli.argv['sim-version'] || sdk === cli.argv['sim-version']) {
											info.devices[sdk].forEach(function (sim) {
												if ((!cli.argv['sim-type'] || sim.deviceClass === cli.argv['sim-type']) && (!cli.argv.retina || sim.retina) && (!cli.argv.tall || sim.tall) && (!cli.argv['sim-64bit'] || sim['64bit'])) {
													options[sdk] || (options[sdk] = []);
													options[sdk].push(sim);
												}
											});
										}
									});
								}

								var params = {
									formatters: {},
									default: '1', // just default to the first one, whatever that will be
									autoSelectOne: true,
									margin: '',
									optionLabel: 'name',
									optionValue: 'udid',
									numbered: true,
									relistOnError: true,
									complete: true,
									suggest: true,
									options: options
								};

								if (cli.argv.target === 'device') {
									// device specific settings
									params.title = __('Which device do you want to install your app on?');
									params.promptLabel = __('Select an device by number or name');
									params.formatters.option = function (opt, idx, num) {
										return '  ' + num + appc.string.rpad(opt.name, info.maxName).cyan + (opt.deviceClass
											? '  ' + opt.deviceClass + ' (' + opt.productVersion + ')'
											: '');
									};
								} else if (cli.argv.target === 'simulator') {
									// simulator specific settings
									params.title = __('Which simulator do you want to launch your app in?');
									params.promptLabel = __('Select an simulator by number or name');
									params.formatters.option = function (opt, idx, num) {
										return '  ' + num + opt.name.cyan;
									};
								}

								callback(fields.select(params));
							},
							required: true,
							validate: function (udid, callback) {
								// this function is called if they specify a --device-id and we need to check that it is valid
								if (typeof udid === 'boolean') {
									return callback(true);
								}

								if (cli.argv.target === 'device' && udid === 'all') {
									// we let 'all' slide by
									return callback(null, udid);
								}

								var info = _t.getDeviceInfo();
								if (info.udids[udid]) {
									callback(null, udid)
								} else {
									callback(new Error(cli.argv.target === 'device' ? __('Invalid iOS device "%s"', udid) : __('Invalid iOS simulator "%s"', udid)));
								}
							},
							verifyIfRequired: function (callback) {
								// this function is called by the CLI when the option is not specified and is required (i.e. missing).
								// the CLI will then double check that this option is still required by calling this function
								if (cli.argv['build-only']) {
									// not required if we're build only
									return callback();
								} else if (cli.argv['device-id'] === undefined && config.get('ios.autoSelectDevice', true)) {
									// --device-id not specified and we're not prompting, so pick a device

									if (cli.argv.target === 'device') {
										cli.argv['device-id'] = iosInfo.devices.length ? iosInfo.devices[0].udid : 'itunes';
										return callback();
									}

									if (cli.argv.target !== 'simulator') {
										return callback(true);
									}

									var info = _t.getDeviceInfo();

									if (info.preferred) {
										// we have a preferred sim based on the legacy cli args and environment
										cli.argv['device-id'] = info.preferred.udid;
										return callback();
									}

									var simVer = cli.argv['sim-version'] || cli.argv['ios-version'],
										simVers = Object.keys(info.devices).filter(function (ver) {
											return !simVer || ver === simVer;
										}),
										deviceFamily = _t.getDeviceFamily(),
										first, firstRetina;

									// try to find us a tall simulator like an iPhone 4 inch
									for (var i = 0, l = simVers.length; i < l; i++) {
										var ver = simVers[i];
										for (var j = 0, k = info.devices[ver].length; j < k; j++) {
											var sim = info.devices[ver][j];
											if (deviceFamily === 'ipad' && sim.deviceClass !== deviceFamily) {
												continue;
											}
											if (!first) {
												// just in case we don't find a tall or retina sim, then we'll just use this sim
												first = sim.udid;
											}
											if (!firstRetina && sim.retina) {
												// just in case we don't find a tall sim, then we'll just use this retina sim
												firstRetina = sim.udid;
											}
											if (sim.type === 'iphone' && sim.tall) {
												// this is the one we really are hoping to find
												cli.argv['device-id'] = sim.udid;
												return callback();
											}
										}
									}

									cli.argv['device-id'] = firstRetina || first;
									return callback();
								}

								// yup, still required
								callback(true);
							}
						},
						'developer-name': {
							abbr: 'V',
							default: process.env.CODE_SIGN_IDENTITY && process.env.CODE_SIGN_IDENTITY.replace(/^iPhone Developer(?:\: )?/, '') || config.get('ios.developerName'),
							desc: __('the iOS Developer Certificate to use; required when target is %s', 'device'.cyan),
							hint: 'name',
							order: 170,
							prompt: function (callback) {
								var developerCerts = {},
									maxDevCertLen = 0;

								Object.keys(iosInfo.certs.keychains).forEach(function (keychain) {
									(iosInfo.certs.keychains[keychain].developer || []).forEach(function (d) {
										if (!d.invalid) {
											Array.isArray(developerCerts[keychain]) || (developerCerts[keychain] = []);
											developerCerts[keychain].push(d);
											maxDevCertLen = Math.max(d.name.length, maxDevCertLen);
										}
									});
								});

								// sort the certs
								Object.keys(developerCerts).forEach(function (keychain) {
									developerCerts[keychain] = developerCerts[keychain].sort(function (a, b) {
										return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
									});
								});

								callback(fields.select({
									title: __("Which developer certificate would you like to use?"),
									promptLabel: __('Select a certificate by number or name'),
									formatters: {
										option: function (opt, idx, num) {
											var expires = moment(opt.after),
												day = expires.format('D'),
												hour = expires.format('h');
											return '  ' + num + appc.string.rpad(opt.name, maxDevCertLen + 1).cyan
												+ (opt.after ? (' (' + __('expires %s', expires.format('MMM') + ' '
												+ (day.length === 1 ? ' ' : '') + day + ', ' + expires.format('YYYY') + ' '
												+ (hour.length === 1 ? ' ' : '') + hour + ':' + expires.format('mm:ss a'))
												+ ')').grey : '');
										}
									},
									margin: '',
									optionLabel: 'name',
									optionValue: 'name',
									numbered: true,
									relistOnError: true,
									complete: true,
									suggest: false,
									options: developerCerts
								}));
							},
							validate: function (value, callback) {
								if (typeof value === 'boolean') {
									return callback(true);
								}
								if (cli.argv.target !== 'device') {
									return callback(null, value);
								}
								if (value) {
									var v = developerCertLookup[value.toLowerCase()];
									if (v) {
										return callback(null, v);
									}
								}
								callback(new Error(__('Invalid developer certificate "%s"', value)));
							}
						},
						'distribution-name': {
							abbr: 'R',
							default: process.env.CODE_SIGN_IDENTITY && process.env.CODE_SIGN_IDENTITY.replace(/^iPhone Distribution(?:\: )?/, '') || config.get('ios.distributionName'),
							desc: __('the iOS Distribution Certificate to use; required when target is %s or %s', 'dist-appstore'.cyan, 'dist-adhoc'.cyan),
							hint: 'name',
							order: 180,
							prompt: function (callback) {
								var distributionCerts = {},
									maxDistCertLen = 0;

								Object.keys(iosInfo.certs.keychains).forEach(function (keychain) {
									(iosInfo.certs.keychains[keychain].distribution || []).forEach(function (d) {
										if (!d.invalid) {
											Array.isArray(distributionCerts[keychain]) || (distributionCerts[keychain] = []);
											distributionCerts[keychain].push(d);
											maxDistCertLen = Math.max(d.name.length, maxDistCertLen);
										}
									});
								});

								// sort the certs
								Object.keys(distributionCerts).forEach(function (keychain) {
									distributionCerts[keychain] = distributionCerts[keychain].sort(function (a, b) {
										return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
									});
								});

								callback(fields.select({
									title: __("Which distribution certificate would you like to use?"),
									promptLabel: __('Select a certificate by number or name'),
									formatters: {
										option: function (opt, idx, num) {
											var expires = moment(opt.after),
												day = expires.format('D'),
												hour = expires.format('h');
											return '  ' + num + appc.string.rpad(opt.name, maxDistCertLen + 1).cyan
												+ (opt.after ? (' (' + __('expires %s', expires.format('MMM') + ' '
												+ (day.length === 1 ? ' ' : '') + day + ', ' + expires.format('YYYY') + ' '
												+ (hour.length === 1 ? ' ' : '') + hour + ':' + expires.format('mm:ss a'))
												+ ')').grey : '');
										}
									},
									margin: '',
									optionLabel: 'name',
									optionValue: 'name',
									numbered: true,
									relistOnError: true,
									complete: true,
									suggest: false,
									options: distributionCerts
								}));
							},
							validate: function (value, callback) {
								if (typeof value === 'boolean') {
									return callback(true);
								}
								if (cli.argv.target !== 'dist-appstore' && cli.argv.target !== 'dist-adhoc') {
									return callback(null, value);
								}
								if (value) {
									var v = distributionCertLookup[value.toLowerCase()];
									if (v) {
										return callback(null, v);
									}
								}
								callback(new Error(__('Invalid distribution certificate "%s"', value)));
							}
						},
						'device-family': {
							abbr: 'F',
							desc: __('the device family to build for'),
							order: 120,
							values: Object.keys(_t.deviceFamilies)
						},
						'ios-version': {
							abbr: 'I',
							callback: function (value) {
								try {
									if (value && allSdkVersions.indexOf(value) !== -1 && version.lt(value, _t.minSupportedIosSdk)) {
										logger.banner();
										logger.error(__('The specified iOS SDK version "%s" is not supported by Titanium %s', value, _t.titaniumSdkVersion) + '\n');
										if (sdkVersions.length) {
											logger.log(__('Available supported iOS SDKs:'));
											sdkVersions.forEach(function (ver) {
												logger.log('   ' + ver.cyan);
											});
											logger.log();
										}
										process.exit(1);
									}
								} catch (e) {
									// squelch and let the cli detect the bad version
								}
							},
							desc: __('iOS SDK version to build with'),
							order: 130,
							prompt: function (callback) {
								callback(fields.select({
									title: __("Which iOS SDK version would you like to build with?"),
									promptLabel: __('Select an iOS SDK version by number or name'),
									margin: '',
									numbered: true,
									relistOnError: true,
									complete: true,
									suggest: false,
									options: sdkVersions
								}));
							},
							values: sdkVersions
						},
						'keychain': {
							abbr: 'K',
							desc: __('path to the distribution keychain to use instead of the system default; only used when target is %s, %s, or %s', 'device'.cyan, 'dist-appstore'.cyan, 'dist-adhoc'.cyan),
							hideValues: true,
							validate: function (value, callback) {
								value && typeof value !== 'string' && (value = null);
								if (value && !fs.existsSync(value)) {
									callback(new Error(__('Unable to find keychain: %s', value)));
								} else {
									callback(null, value);
								}
							}
						},
						'launch-url': {
							// url for the application to launch in mobile Safari, as soon as the app boots up
							hidden: true
						},
						'output-dir': {
							abbr: 'O',
							desc: __('the output directory when using %s', 'dist-adhoc'.cyan),
							hint: 'dir',
							order: 200,
							prompt: function (callback) {
								callback(fields.file({
									promptLabel: __('Where would you like the output IPA file saved?'),
									default: cli.argv['project-dir'] && appc.fs.resolvePath(cli.argv['project-dir'], 'dist'),
									complete: true,
									showHidden: true,
									ignoreDirs: _t.ignoreDirs,
									ignoreFiles: /.*/,
									validate: _t.conf.options['output-dir'].validate.bind(_t)
								}));
							},
							validate: function (outputDir, callback) {
								callback(outputDir || !_t.conf.options['output-dir'].required ? null : new Error(__('Invalid output directory')), outputDir);
							}
						},
						'pp-uuid': {
							abbr: 'P',
							default: process.env.PROVISIONING_PROFILE,
							desc: __('the provisioning profile uuid; required when target is %s, %s, or %s', 'device'.cyan, 'dist-appstore'.cyan, 'dist-adhoc'.cyan),
							hint: 'uuid',
							order: 190,
							prompt: function (callback) {
								var provisioningProfiles = {},
									appId = cli.tiapp.id,
									maxAppId = 0,
									pp;

								function prep(a) {
									return a.filter(function (p) {
										if (!p.expired) {
											var re = new RegExp(p.appId.replace(/\./g, '\\.').replace(/\*/g, '.*'));
											if (re.test(appId)) {
												var label = p.name;
												if (label.indexOf(p.appId) === -1) {
													label += ': ' + p.appId;
												}
												p.label = label;
												maxAppId = Math.max(p.label.length, maxAppId);
												return true;
											}
										}
									}).sort(function (a, b) {
										return a.label.toLowerCase().localeCompare(b.label.toLowerCase());
									});
								}

								if (cli.argv.target === 'device') {
									if (iosInfo.provisioning.development.length) {
										pp = prep(iosInfo.provisioning.development);
										if (pp.length) {
											provisioningProfiles[__('Available Development UUIDs:')] = pp;
										} else {
											logger.error(__('Unable to find any non-expired development provisioning profiles that match the app id "%s"', appId) + '\n');
											logger.log(__('You will need to login into %s with your Apple Download account, then create, download, and install a profile.',
												'http://appcelerator.com/ios-dev-certs'.cyan) + '\n');
											process.exit(1);
										}
									} else {
										logger.error(__('Unable to find any development provisioning profiles') + '\n');
										logger.log(__('You will need to login into %s with your Apple Download account, then create, download, and install a profile.',
											'http://appcelerator.com/ios-dev-certs'.cyan) + '\n');
										process.exit(1);
									}
								} else if (cli.argv.target === 'dist-appstore' || cli.argv.target === 'dist-adhoc') {
									if (iosInfo.provisioning.distribution.length || iosInfo.provisioning.adhoc.length) {
										pp = prep(iosInfo.provisioning.distribution);
										var valid = pp.length;
										if (pp.length) {
											provisioningProfiles[__('Available Distribution UUIDs:')] = pp;
										}

										pp = prep(iosInfo.provisioning.adhoc);
										valid += pp.length;
										if (pp.length) {
											provisioningProfiles[__('Available Adhoc UUIDs:')] = pp;
										}

										if (!valid) {
											logger.error(__('Unable to find any non-expired distribution or adhoc provisioning profiles that match the app id "%s".', appId) + '\n');
											logger.log(__('You will need to login into %s with your Apple Download account, then create, download, and install a profile.',
												'http://appcelerator.com/ios-dist-certs'.cyan) + '\n');
											process.exit(1);
										}
									} else {
										logger.error(__('Unable to find any distribution or adhoc provisioning profiles'));
										logger.log(__('You will need to login into %s with your Apple Download account, then create, download, and install a profile.',
											'http://appcelerator.com/ios-dist-certs'.cyan) + '\n');
										process.exit(1);
									}
								}

								callback(fields.select({
									title: __("Which provisioning profile would you like to use?"),
									promptLabel: __('Select a provisioning profile UUID by number or name'),
									formatters: {
										option: function (opt, idx, num) {
											var expires = moment(opt.expirationDate),
												day = expires.format('D'),
												hour = expires.format('h');
											return '  ' + num + String(opt.uuid).cyan + ' '
												+ appc.string.rpad(opt.label, maxAppId + 1)
												+ (opt.expirationDate ? (' (' + __('expires %s', expires.format('MMM') + ' '
												+ (day.length === 1 ? ' ' : '') + day + ', ' + expires.format('YYYY') + ' '
												+ (hour.length === 1 ? ' ' : '') + hour + ':' + expires.format('mm:ss a'))
												+ ')').grey : '');
										}
									},
									margin: '',
									optionLabel: 'name',
									optionValue: 'uuid',
									numbered: true,
									relistOnError: true,
									complete: true,
									suggest: false,
									options: provisioningProfiles
								}));
							},
							validate: function (value, callback) {
								if (cli.argv.target === 'simulator') {
									return callback(null, value);
								}
								if (value) {
									var v = provisioningProfileLookup[value.toLowerCase()];
									if (v) {
										return callback(null, v);
									}
									return callback(new Error(__('Invalid provisioning profile UUID "%s"', value)));
								}
								callback(true);
							}
						},
						'profiler-host': {
							hidden: true
						},
						'sim-type': {
							abbr: 'Y',
							desc: __('iOS Simulator type; only used when target is %s', 'simulator'.cyan),
							hint: 'type',
							order: 150,
							values: Object.keys(_t.simTypes)
						},
						'sim-version': {
							abbr: 'S',
							desc: __('iOS Simulator version; only used when target is %s', 'simulator'.cyan),
							hint: 'version',
							order: 160,
							values: simVersions
						},
						'target': {
							abbr: 'T',
							callback: function (value) {
								// if we're building from Xcode, no need to check certs and provisioning profiles
								if (cli.argv.xcode) {
									_t.conf.options['developer-name'].required = false;
									_t.conf.options['device-id'].required = false;
									_t.conf.options['distribution-name'].required = false;
									_t.conf.options['pp-uuid'].required = false;
									return;
								}

								if (value !== 'simulator') {
									_t.assertIssue(iosInfo.issues, 'IOS_NO_KEYCHAINS_FOUND');
									_t.assertIssue(iosInfo.issues, 'IOS_NO_WWDR_CERT_FOUND');
								}

								// as soon as we know the target, toggle required options for validation
								switch (value) {
									case 'device':
										_t.assertIssue(iosInfo.issues, 'IOS_NO_VALID_DEV_CERTS_FOUND');
										_t.assertIssue(iosInfo.issues, 'IOS_NO_VALID_DEVELOPMENT_PROVISIONING_PROFILES');
										iosInfo.provisioning.development.forEach(function (d) {
											provisioningProfileLookup[d.uuid.toLowerCase()] = d.uuid;
										});
										_t.conf.options['developer-name'].required = true;
										_t.conf.options['pp-uuid'].required = true;
										break;

									case 'dist-adhoc':
										_t.assertIssue(iosInfo.issues, 'IOS_NO_VALID_DIST_CERTS_FOUND');
										// TODO: assert there is at least one distribution or adhoc provisioning profile

										_t.conf.options['output-dir'].required = true;

										// purposely fall through!

									case 'dist-appstore':
										_t.assertIssue(iosInfo.issues, 'IOS_NO_VALID_DIST_CERTS_FOUND');

										_t.conf.options['deploy-type'].values = ['production'];
										_t.conf.options['device-id'].required = false;
										_t.conf.options['distribution-name'].required = true;
										_t.conf.options['pp-uuid'].required = true;

										// build lookup maps
										iosInfo.provisioning.distribution.forEach(function (d) {
											provisioningProfileLookup[d.uuid.toLowerCase()] = d.uuid;
										});
										iosInfo.provisioning.adhoc.forEach(function (d) {
											provisioningProfileLookup[d.uuid.toLowerCase()] = d.uuid;
										});
								}
							},
							default: process.env.CURRENT_ARCH && process.env.CURRENT_ARCH !== 'i386' ? 'device' : 'simulator',
							desc: __('the target to build for'),
							order: 110,
							required: true,
							values: _t.targets
						}
					}
				});
			})(function (err, result) {
				done(_t.conf = result);
			});
		}.bind(this)); // end of ioslib.detect()
	}.bind(this);
};

iOSBuilder.prototype.validate = function (logger, config, cli) {
	Builder.prototype.validate.apply(this, arguments);

	this.target = cli.argv.target;

	if (cli.argv.xcode) {
		this.deployType = cli.argv['deploy-type'] || this.deployTypes[this.target];
	} else {
		this.deployType = !/^dist-/.test(this.target) && cli.argv['deploy-type'] ? cli.argv['deploy-type'] : this.deployTypes[this.target];
	}

	this.buildType = cli.argv['build-type'] || '';

	// manually inject the build profile settings into the tiapp.xml
	switch (this.deployType) {
		case 'production':
			this.minifyJS = true;
			this.encryptJS = true;
			this.allowDebugging = false;
			this.allowProfiling = false;
			this.includeAllTiModules = false;
			this.compileI18N = true;
			this.compileJSS = true;
			break;

		case 'test':
			this.minifyJS = true;
			this.encryptJS = true;
			this.allowDebugging = true;
			this.allowProfiling = true;
			this.includeAllTiModules = false;
			this.compileI18N = true;
			this.compileJSS = true;
			break;

		case 'development':
		default:
			this.minifyJS = false;
			this.encryptJS = false;
			this.allowDebugging = true;
			this.allowProfiling = true;
			this.includeAllTiModules = true;
			this.compileI18N = false;
			this.compileJSS = false;
	}

	if (cli.argv['skip-js-minify']) {
		this.minifyJS = false;
	}

	// at this point we've validated everything except underscores in the app id
	if (!config.get('app.skipAppIdValidation') && !cli.tiapp.properties['ti.skipAppIdValidation']) {
		if (!/^([a-zA-Z_]{1}[a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]*)*)$/.test(cli.tiapp.id)) {
			logger.error(__('tiapp.xml contains an invalid app id "%s"', cli.tiapp.id));
			logger.error(__('The app id must consist only of letters, numbers, dashes, and underscores.'));
			logger.error(__('Note: iOS does not allow underscores.'));
			logger.error(__('The first character must be a letter or underscore.'));
			logger.error(__("Usually the app id is your company's reversed Internet domain name. (i.e. com.example.myapp)") + '\n');
			process.exit(1);
		}

		if (cli.tiapp.id.indexOf('_') !== -1) {
			logger.error(__('tiapp.xml contains an invalid app id "%s"', cli.tiapp.id));
			logger.error(__('The app id must consist of letters, numbers, and dashes.'));
			logger.error(__('The first character must be a letter.'));
			logger.error(__("Usually the app id is your company's reversed Internet domain name. (i.e. com.example.myapp)") + '\n');
			process.exit(1);
		}
	}

	if (!cli.argv['ios-version']) {
		if (this.iosSdkVersions.length) {
			// set the latest version
			cli.argv['ios-version'] = this.defaultIosVersion;
		} else {
			// this should not be possible, but you never know
			logger.error(cli.argv['ios-version'] ? __('Unable to find iOS SDK %s', cli.argv['ios-version']) + '\n' : __('Missing iOS SDK') + '\n');
			logger.log(__('Available iOS SDK versions:'));
			this.iosSdkVersions.forEach(function (ver) {
				logger.log('    ' + ver.cyan);
			});
			logger.log();
			process.exit(1);
		}
	}
	this.iosSdkVersion = cli.argv['ios-version'];

	// figure out the min-ios-ver that this app is going to support
	var defaultMinIosSdk = this.packageJson.minIosVersion;
	this.minIosVer = cli.tiapp.ios && cli.tiapp.ios['min-ios-ver'] || defaultMinIosSdk;
	this.minIosVerMessage = null; // we store the message below in this variable so that we can output info stuff after validation
	if (version.gte(this.iosSdkVersion, '6.0') && version.lt(this.minIosVer, defaultMinIosSdk)) {
		this.minIosVerMessage = __('Building for iOS %s; using %s as minimum iOS version', version.format(this.iosSdkVersion, 2).cyan, defaultMinIosSdk.cyan);
		this.minIosVer = defaultMinIosSdk;
	} else if (version.lt(this.minIosVer, defaultMinIosSdk)) {
		this.minIosVerMessage = __('The %s of the iOS section in the tiapp.xml is lower than minimum supported version: Using %s as minimum', 'min-ios-ver'.cyan, version.format(defaultMinIosSdk, 2).cyan);
		this.minIosVer = defaultMinIosSdk;
	} else if (version.gt(this.minIosVer, this.iosSdkVersion)) {
		this.minIosVerMessage = __('The %s of the iOS section in the tiapp.xml is greater than the specified %s: Using %s as minimum', 'min-ios-ver'.cyan, 'ios-version'.cyan, version.format(this.iosSdkVersion, 2).cyan);
		this.minIosVer = this.iosSdkVersion;
	}

	// check the min-ios-ver for the device we're installing to
	if (this.target === 'device') {
		this.getDeviceInfo().devices.forEach(function (device) {
			if (device.udid !== 'all' && device.udid !== 'itunes' && (cli.argv['device-id'] === 'all' || cli.argv['device-id'] === device.udid) && version.lt(device.productVersion, this.minIosVer)) {
				logger.error(__('This app does not support the device "%s"', device.name) + '\n');
				logger.log(__("The device is running iOS %s, however the app's the minimum iOS version is set to %s", device.productVersion.cyan, version.format(this.minIosVer, 2, 3).cyan));
				logger.log(__('In order to install this app on this device, lower the %s to %s in the tiapp.xml:', '<min-ios-ver>'.cyan, version.format(device.productVersion, 2, 2).cyan));
				logger.log();
				logger.log('<ti:app xmlns:ti="http://ti.appcelerator.org">'.grey);
				logger.log('    <ios>'.grey);
				logger.log(('        <min-ios-ver>' + version.format(device.productVersion, 2, 2) + '</min-ios-ver>').magenta);
				logger.log('    </ios>'.grey);
				logger.log('</ti:app>'.grey);
				logger.log();
				process.exit(0);
			}
		}, this);
	}

	// make sure the app doesn't have any blacklisted directories in the Resources directory and warn about graylisted names
	var resourcesDir = path.join(cli.argv['project-dir'], 'Resources');
	if (fs.existsSync(resourcesDir)) {
		fs.readdirSync(resourcesDir).forEach(function (filename) {
			var lcaseFilename = filename.toLowerCase(),
				isDir = fs.statSync(path.join(resourcesDir, filename)).isDirectory();

			if (this.blacklistDirectories.indexOf(lcaseFilename) !== -1) {
				if (isDir) {
					logger.error(__('Found blacklisted directory in the Resources directory') + '\n');
					logger.error(__('The directory "%s" is a reserved word.', filename));
					logger.error(__('You must rename this directory to something else.') + '\n');
				} else {
					logger.error(__('Found blacklisted file in the Resources directory') + '\n');
					logger.error(__('The file "%s" is a reserved word.', filename));
					logger.error(__('You must rename this file to something else.') + '\n');
				}
				process.exit(1);
			} else if (this.graylistDirectories.indexOf(lcaseFilename) !== -1) {
				if (isDir) {
					logger.warn(__('Found graylisted directory in the Resources directory'));
					logger.warn(__('The directory "%s" is potentially a reserved word.', filename));
					logger.warn(__('There is a good chance your app will be rejected by Apple.'));
					logger.warn(__('It is highly recommended you rename this directory to something else.'));
				} else {
					logger.warn(__('Found graylisted file in the Resources directory'));
					logger.warn(__('The file "%s" is potentially a reserved word.', filename));
					logger.warn(__('There is a good chance your app will be rejected by Apple.'));
					logger.warn(__('It is highly recommended you rename this file to something else.'));
				}
			}
		}, this);
	}

	// we have an ios sdk version, find the best xcode version to use
	this.xcodeEnv = null;
	Object.keys(this.iosInfo.xcode).forEach(function (ver) {
		if (this.iosInfo.xcode[ver].supported && (!this.xcodeEnv || this.iosInfo.xcode[ver].selected) && this.iosInfo.xcode[ver].sdks.some(function (sdk) { return version.eq(sdk, cli.argv['ios-version']); }, this)) {
			this.xcodeEnv = this.iosInfo.xcode[ver];
		}
	}, this);
	if (!this.xcodeEnv) {
		// this should never happen
		logger.error(__('Unable to find suitable Xcode install that supports iOS SDK %s', cli.argv['ios-version']) + '\n');
		process.exit(1);
	}

	// check if we are running from Xcode
	if (cli.argv.xcode) {
		cli.argv['skip-js-minify'] = true; // never minify Xcode builds
		cli.argv['force-copy']     = true; // if building from xcode, we'll force files to be copied instead of symlinked
		cli.argv['force-copy-all'] = false; // we don't want to copy the big libTiCore.a file around by default
	}

	// if in the prepare phase and doing a device/dist build...
	if (!cli.argv.xcode && cli.argv.target !== 'simulator') {
		// make sure they have Apple's WWDR cert installed
		if (!this.iosInfo.certs.wwdr) {
			logger.error(__('WWDR Intermediate Certificate not found') + '\n');
			logger.log(__('Download and install the certificate from %s', 'http://appcelerator.com/ios-wwdr'.cyan) + '\n');
			process.exit(1);
		}

		// validate keychain
		var keychain = cli.argv.keychain ? appc.fs.resolvePath(cli.argv.keychain) : null;
		if (keychain && !fs.existsSync(keychain)) {
			logger.error(__('Unable to find keychain "%s"', keychain) + '\n');
			logger.log(__('Available keychains:'));
			Object.keys(this.iosInfo.certs.keychains).forEach(function (kc) {
				logger.log('    ' + kc.cyan);
			});
			logger.log();
			appc.string.suggest(keychain, Object.keys(this.iosInfo.certs.keychains), logger.log);
			process.exit(1);
		}
	}

	var deviceFamily = this.getDeviceFamily();
	if (!deviceFamily) {
		logger.info(__('No device family specified, defaulting to %s', 'universal'));
		deviceFamily = this.deviceFamily = 'universal';
	}

	if (!this.deviceFamilies[deviceFamily]) {
		logger.error(__('Invalid device family "%s"', deviceFamily) + '\n');
		appc.string.suggest(deviceFamily, Object.keys(this.deviceFamilies), logger.log, 3);
		process.exit(1);
	}

	// device family may have been modified, so set it back in the args
	cli.argv['device-family'] = deviceFamily;

	// check that the sim version exists
	if (cli.argv.target === 'simulator' && this.xcodeEnv.sims.indexOf(cli.argv['sim-version']) === -1) {
		// the preferred Xcode install we selected doesn't have this simulator, search the all again
		this.xcodeEnv = null;
		var selectedSim = this.getDeviceInfo().udids[cli.argv['device-id']];

		// check if we have a selected simulator; we won't if running with --build-only
		if (selectedSim) {
			// check the device family
			if (deviceFamily === 'ipad' && deviceFamily !== selectedSim.type) {
				logger.error(__('Unable to build an %s app for an %s simulator', this.simTypes[deviceFamily] || deviceFamily, this.simTypes[selectedSim.type]) + '\n');
				logger.log(__('Please specify "%s" to launch a compatible iOS Simulator.', ('--sim-type ' + deviceFamily).cyan));
				logger.log();
				process.exit(1);
			}
		}

		Object.keys(this.iosInfo.xcode).forEach(function (ver) {
			if (this.iosInfo.xcode[ver].supported
				&& !this.xcodeEnv
				&& this.iosInfo.xcode[ver].sdks.some(function (sdk) { return version.eq(sdk, cli.argv['ios-version']); })
				&& (!selectedSim || this.iosInfo.xcode[ver].sims.some(function (sim) { return version.eq(sim, selectedSim.ios); }))
			) {
				this.xcodeEnv = this.iosInfo.xcode[ver];
			}
		}, this);

		if (!this.xcodeEnv) {
			// this should never happen
			if (selectedSim) {
				logger.error(__('Unable to find any Xcode installs that have iOS SDK %s and iOS Simulator %s', cli.argv['ios-version'], selectedSim.ios) + '\n');
			} else {
				logger.error(__('Unable to find any Xcode installs that have iOS SDK %s', cli.argv['ios-version']) + '\n');
			}
			logger.log(__('Available iOS SDKs and iOS Simulators:'));
			Object.keys(this.iosInfo.xcode).forEach(function (ver) {
				if (this.iosInfo.xcode[ver].supported) {
					this.iosInfo.xcode[ver].sdks.forEach(function (sdk) {
						logger.log('\n  ' + __('iOS %s:', sdk));
						this.iosInfo.xcode[ver].sims.forEach(function (sim) {
							logger.log('    ' + ('--ios-version ' + sdk + ' --sim-version ' + sim).cyan);
						});
					}, this);
				}
			}, this);
			logger.log();
			process.exit(1);
		}
	}

	if (cli.argv.target !== 'dist-appstore') {
		var tool = [];
		this.allowDebugging && tool.push('debug');
		this.allowProfiling && tool.push('profiler');
		tool.forEach(function (type) {
			if (cli.argv[type + '-host']) {
				if (typeof cli.argv[type + '-host'] === 'number') {
					logger.error(__('Invalid %s host "%s"', type, cli.argv[type + '-host']) + '\n');
					logger.log(__('The %s host must be in the format "host:port".', type) + '\n');
					process.exit(1);
				}

				var parts = cli.argv[type + '-host'].split(':');

				if ((cli.argv.target === 'simulator' && parts.length < 2) || (cli.argv.target !== 'simulator' && parts.length < 4)) {
					logger.error(__('Invalid ' + type + ' host "%s"', cli.argv[type + '-host']) + '\n');
					if (cli.argv.target === 'simulator') {
						logger.log(__('The %s host must be in the format "host:port".', type) + '\n');
					} else {
						logger.log(__('The %s host must be in the format "host:port:airkey:hosts".', type) + '\n');
					}
					process.exit(1);
				}

				if (parts.length > 1 && parts[1]) {
					var port = parseInt(parts[1]);
					if (isNaN(port) || port < 1 || port > 65535) {
						logger.error(__('Invalid ' + type + ' host "%s"', cli.argv[type + '-host']) + '\n');
						logger.log(__('The port must be a valid integer between 1 and 65535.') + '\n');
						process.exit(1);
					}
				}
			}
		});
	}

	return function (callback) {
		this.validateTiModules(['ios', 'iphone'], this.deployType, function (err, modules) {
			this.modules = modules.found;

			this.commonJsModules = [];
			this.nativeLibModules = [];

			var nativeHashes = [];

			modules.found.forEach(function (module) {
				if (module.platform.indexOf('commonjs') !== -1) {
					module.native = false;

					module.libFile = path.join(module.modulePath, module.id + '.js');
					if (!fs.existsSync(module.libFile)) {
						this.logger.error(__('Module %s version %s is missing module file: %s', module.id.cyan, (module.manifest.version || 'latest').cyan, module.libFile.cyan) + '\n');
						process.exit(1);
					}

					this.commonJsModules.push(module);
				} else {
					module.native = true;

					module.libName = 'lib' + module.id.toLowerCase() + '.a',
					module.libFile = path.join(module.modulePath, module.libName);

					if (!fs.existsSync(module.libFile)) {
						this.logger.error(__('Module %s version %s is missing library file: %s', module.id.cyan, (module.manifest.version || 'latest').cyan, module.libFile.cyan) + '\n');
						process.exit(1);
					}

					nativeHashes.push(module.hash = this.hash(fs.readFileSync(module.libFile)));
					this.nativeLibModules.push(module);
				}

				// scan the module for any CLI hooks
				cli.scanHooks(path.join(module.modulePath, 'hooks'));
			}, this);

			this.modulesNativeHash = this.hash(nativeHashes.length ? nativeHashes.sort().join(',') : '');

			callback();
		}.bind(this));
	}.bind(this);
};

iOSBuilder.prototype.run = function (logger, config, cli, finished) {
	Builder.prototype.run.apply(this, arguments);

	// force the platform to "ios" just in case it was "iphone" so that plugins can reference it
	cli.argv.platform = 'ios';

	// if in the xcode phase, bypass the pre, post, and finalize hooks for xcode builds
	if (cli.argv.xcode) {
		series(this, [
			'initialize',
			'loginfo',
			'xcodePrecompilePhase',
			'optimizeImages'
		], function () {
			finished();
		});
		return;
	}

	series(this, [
		function (next) {
			cli.emit('build.pre.construct', this, next);
		},

		'doAnalytics',
		'initialize',
		'loginfo',
		'readBuildManifest',
		'checkIfNeedToRecompile',
		'preparePhase',

		function (next) {
			cli.emit('build.pre.compile', this, next);
		},

		function (next) {
			// Make sure we have an app.js. This used to be validated in validate(), but since plugins like
			// Alloy generate an app.js, it may not have existed during validate(), but should exist now
			// that build.pre.compile was fired.
			ti.validateAppJsExists(this.projectDir, this.logger, ['iphone', 'ios']);
			next();
		},

		'initBuildDir',
		'updateXCConfig',
		'createInfoPlist',
		'createEntitlementsPlist',
		'injectModulesIntoXcodeProject',
		'injectApplicationDefaults', // if ApplicationDefaults.m was modified, forceRebuild will be set to true
		'copyTitaniumLibraries',
		'copyItunesArtwork',
		'copyGraphics',
		'validateExtentions',
		'invokeXcodeBuildOnExtensionDependencies',
		'injectExtensionsIntoXcodeProject',

		function (next) {
			// this is a hack... for non-deployment builds we need to force xcode so that the pre-compile phase
			// is run and the ApplicationRouting.m gets updated
			if (!this.forceRebuild && this.deployType !== 'development') {
				this.logger.info(__('Forcing rebuild: deploy type is %s, so need to recompile ApplicationRouting.m', this.deployType));
				this.forceRebuild = true;
			}

			this.xcodePrecompilePhase(function () {
				if (this.forceRebuild || !fs.existsSync(this.xcodeAppDir)) {
					// we're not being called from Xcode, so we can call the pre-compile phase now
					// and save us several seconds
					parallel(this, [
						'optimizeImages',
						'invokeXcodeBuild'
					], next);
				} else {
					this.logger.info(__('Skipping xcodebuild'));
					next();
				}
			}.bind(this));
		},

		'writeBuildManifest',

		function (next) {
			if (!this.buildOnly && this.target === 'simulator') {
				var delta = appc.time.prettyDiff(this.cli.startTime, Date.now());
				this.logger.info(__('Finished building the application in %s', delta.cyan));
			}

			cli.emit('build.post.compile', this, next);
		},

		function (next) {
			cli.emit('build.finalize', this, next);
		}
	], finished);
};

iOSBuilder.prototype.doAnalytics = function doAnalytics(next) {
	var cli = this.cli,
		eventName = cli.argv['device-family'] + '.' + cli.argv.target;

	if (cli.argv.target === 'dist-appstore' || cli.argv.target === 'dist-adhoc') {
		eventName = cli.argv['device-family'] + '.distribute.' + cli.argv.target.replace('dist-', '');
	} else if (this.allowDebugging && cli.argv['debug-host']) {
		eventName += '.debug';
	} else if (this.allowProfiling && cli.argv['profiler-host']) {
		eventName += '.profile';
	} else {
		eventName += '.run';
	}

	cli.addAnalyticsEvent(eventName, {
		dir: cli.argv['project-dir'],
		name: cli.tiapp.name,
		publisher: cli.tiapp.publisher,
		url: cli.tiapp.url,
		image: cli.tiapp.icon,
		appid: cli.tiapp.id,
		description: cli.tiapp.description,
		type: cli.argv.type,
		guid: cli.tiapp.guid,
		version: cli.tiapp.version,
		copyright: cli.tiapp.copyright,
		date: (new Date()).toDateString()
	});

	next();
};

iOSBuilder.prototype.initialize = function initialize(next) {
	var argv = this.cli.argv;

	this.templatesDir = path.join(this.platformPath, 'templates', 'build');

	this.moduleSearchPaths = [ this.projectDir, appc.fs.resolvePath(this.platformPath, '..', '..', '..', '..') ];
	if (this.config.paths && Array.isArray(this.config.paths.modules)) {
		this.moduleSearchPaths = this.moduleSearchPaths.concat(this.config.paths.modules);
	}

	this.provisioningProfileUUID = argv['pp-uuid'];
	this.buildOnly = argv['build-only'];
	this.debugHost = this.allowDebugging && argv['debug-host'];
	this.profilerHost = this.allowProfiling && argv['profiler-host'];
	this.launchUrl = argv['launch-url'];
	this.keychain = argv.keychain;
	this.deviceId = argv['device-id'];
	this.deviceInfo = this.deviceId ? this.getDeviceInfo().udids[this.deviceId] : null;
	this.xcodeTarget = process.env.CONFIGURATION || (/^device|simulator$/.test(this.target) ? 'Debug' : 'Release');
	this.xcodeTargetOS = (this.target === 'simulator' ? 'iphonesimulator' : 'iphoneos') + version.format(this.iosSdkVersion, 2, 2);
	this.iosBuildDir = path.join(this.buildDir, 'build', this.xcodeTarget + '-' + (this.target === 'simulator' ? 'iphonesimulator' : 'iphoneos'));
	this.xcodeAppDir = argv.xcode && process.env.TARGET_BUILD_DIR && process.env.CONTENTS_FOLDER_PATH ? path.join(process.env.TARGET_BUILD_DIR, process.env.CONTENTS_FOLDER_PATH) : path.join(this.iosBuildDir, this.tiapp.name + '.app');
	this.xcodeProjectConfigFile = path.join(this.buildDir, 'project.xcconfig');
	this.certDeveloperName = argv['developer-name'];
	this.certDistributionName = argv['distribution-name'];
	this.forceCopy = !!argv['force-copy'];
	this.forceCopyAll = !!argv['force-copy-all'];

	this.forceCleanBuild = false;
	this.forceRebuild = false;

	this.buildAssetsDir    = path.join(this.buildDir, 'assets');
	this.buildManifestFile = path.join(this.buildDir, 'build-manifest.json');

	// make sure we have an icon
	if (!this.tiapp.icon || !['Resources', 'Resources/iphone', 'Resources/ios'].some(function (p) {
			return fs.existsSync(this.projectDir, p, this.tiapp.icon);
		}, this)) {
		this.tiapp.icon = 'appicon.png';
	}

	this.architectures = 'armv7 arm64 x86_64 i386';
	// no armv6 support above 4.3 or with 6.0+ SDK
	//if (version.gte(this.iosSdkVersion, '6.0')) {
	//	this.architectures = 'armv7 armv7s i386';
	//} else if (version.gte(this.minIosVer, '4.3')) {
	//	this.architectures = 'armv7 i386';
	//}

	this.imagesOptimizedFile = path.join(this.buildDir, 'images_optimized');
	fs.existsSync(this.imagesOptimizedFile) && fs.unlinkSync(this.imagesOptimizedFile);

	//This is default behavior for now. Move this to true in phase 2. 
	//Remove this logic when we have debugging/profiling support with JSCore framework
	//TIMOB-17892
	if (this.cli.tiapp.ios && this.cli.tiapp.ios['use-jscore-framework']){
		this.useJSCore = true;
	}

	if (this.debugHost || this.profilerHost) {
		this.useJSCore = false;
	}

	next();
};

iOSBuilder.prototype.loginfo = function loginfo(next) {
	this.logger.debug(__('Titanium SDK iOS directory: %s', this.platformPath.cyan));
	this.logger.info(__('Deploy type: %s', this.deployType.cyan));
	this.logger.info(__('Building for target: %s', this.target.cyan));
	this.logger.info(__('Building using iOS SDK: %s', version.format(this.iosSdkVersion, 2).cyan));
	this.minIosVerMessage && this.logger.info(this.minIosVerMessage);

	if (this.buildOnly) {
		this.logger.info(__('Performing build only'));
	} else {
		if (this.target === 'simulator') {
			this.logger.info(__('Building for iOS Simulator: %s', this.deviceInfo.name.cyan));
			this.logger.debug(__('UDID: %s', this.deviceId.cyan));
			this.logger.debug(__('Simulator type: %s', this.deviceInfo.type.cyan));
			this.logger.debug(__('Simulator version: %s', this.deviceInfo.ios.cyan));
		} else if (this.target === 'device') {
			this.logger.info(__('Building for iOS device: %s', this.deviceId.cyan));
		}
	}

	this.logger.info(__('Building for device family: %s', this.deviceFamily.cyan));
	this.logger.debug(__('Setting Xcode target to %s', this.xcodeTarget.cyan));
	this.logger.debug(__('Setting Xcode build OS to %s', this.xcodeTargetOS.cyan));
	this.logger.debug(__('Xcode installation: %s', this.xcodeEnv.path.cyan));
	this.logger.debug(__('iOS WWDR certificate: %s', this.iosInfo.certs.wwdr ? __('installed').cyan : __('not found').cyan));
	//this.logger.debug(__('Building for the following architectures: %s', this.architectures.cyan));

	if (!this.cli.argv.xcode) {
		if (this.target === 'device') {
			this.logger.info(__('iOS Development Certificate: %s', this.certDeveloperName.cyan));
		} else if (/^dist-appstore|dist\-adhoc$/.test(this.target)) {
			this.logger.info(__('iOS Distribution Certificate: %s', this.certDistributionName.cyan));
		}
	}

	// validate the min-ios-ver from the tiapp.xml
	this.logger.info(__('Minimum iOS version: %s', version.format(this.minIosVer, 2, 3).cyan));

	if (/^device|dist\-appstore|dist\-adhoc$/.test(this.target)) {
		if (this.keychain) {
			this.logger.info(__('Using keychain: %s', this.keychain));
		} else {
			this.logger.info(__('Using default keychain'));
		}
	}

	if (this.debugHost) {
		this.logger.info(__('Debugging enabled via debug host: %s', this.debugHost.cyan));
	} else {
		this.logger.info(__('Debugging disabled'));
	}

	if (this.profilerHost) {
		this.logger.info(__('Profiler enabled via profiler host: %s', this.profilerHost.cyan));
	} else {
		this.logger.info(__('Profiler disabled'));
	}

	next();
};

iOSBuilder.prototype.readBuildManifest = function readBuildManifest(next) {
	// read the build manifest from the last build, if exists, so we
	// can determine if we need to do a full rebuild
	this.buildManifest = {};

	if (fs.existsSync(this.buildManifestFile)) {
		try {
			this.buildManifest = JSON.parse(fs.readFileSync(this.buildManifestFile)) || {};
		} catch (e) {}
	}

	next();
};

iOSBuilder.prototype.checkIfShouldForceCleanBuild = function checkIfShouldForceCleanBuild() {
	if (fs.existsSync(this.xcodeProjectConfigFile)) {
		// we have a previous build, see if the Titanium SDK changed
		var conf = fs.readFileSync(this.xcodeProjectConfigFile).toString(),
			versionMatch = conf.match(/TI_VERSION\=([^\n]*)/);

		if (versionMatch && !appc.version.eq(versionMatch[1], this.titaniumSdkVersion)) {
			this.logger.info(__("Forcing clean: last build was under Titanium SDK version %s and we're compiling for version %s", versionMatch[1].cyan, this.titaniumSdkVersion.cyan));
			return true;
		}
	}

	return false;
}

iOSBuilder.prototype.checkIfShouldForceRebuild = function checkIfShouldForceRebuild() {
	var manifest = this.buildManifest;

	if (this.cli.argv.force) {
		this.logger.info(__('Forcing rebuild: %s flag was set', '--force'.cyan));
		return true;
	}

	if (!fs.existsSync(this.buildManifestFile)) {
		// if no .version file, rebuild!
		this.logger.info(__('Forcing rebuild: %s does not exist', this.buildManifestFile.cyan));
		return true;
	}

	// check if the target changed
	if (this.target !== manifest.target) {
		this.logger.info(__('Forcing rebuild: target changed since last build'));
		this.logger.info('  ' + __('Was: %s', this.buildManifest.target));
		this.logger.info('  ' + __('Now: %s', this.target));
		return true;
	}

	if (fs.existsSync(this.xcodeProjectConfigFile)) {
		// we have a previous build, see if the app id changed
		var conf = fs.readFileSync(this.xcodeProjectConfigFile).toString(),
			idMatch = conf.match(/TI_APPID\=([^\n]*)/);

		if (idMatch && idMatch[1] !== this.tiapp.id) {
			this.logger.info(__("Forcing rebuild: app id changed from %s to %s", idMatch[1].cyan, this.tiapp.id.cyan));
			return true;
		}
	}

	if (!fs.existsSync(this.xcodeAppDir)) {
		this.logger.info(__('Forcing rebuild: %s does not exist', this.xcodeAppDir.cyan));
		return true;
	}

	// check that we have a libTiCore hash
	if (!manifest.tiCoreHash) {
		this.logger.info(__('Forcing rebuild: incomplete version file %s', this.buildVersionFile.cyan));
		return true;
	}

	// check if the libTiCore hashes are different
	if (this.libTiCoreHash !== manifest.tiCoreHash) {
		this.logger.info(__('Forcing rebuild: libTiCore hash changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.tiCoreHash));
		this.logger.info('  ' + __('Now: %s', this.libTiCoreHash));
		return true;
	}

	// check if the titanium sdk paths are different
	if (manifest.iosSdkPath !== this.platformPath) {
		this.logger.info(__('Forcing rebuild: Titanium SDK path changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.iosSdkPath));
		this.logger.info('  ' + __('Now: %s', this.platformPath));
		return true;
	}

	// check if the iOS SDK has changed
	if (manifest.iosSdkVersion !== this.iosSdkVersion) {
		this.logger.info(__('Forcing rebuild: iOS SDK version changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.iosSdkVersion));
		this.logger.info('  ' + __('Now: %s', this.iosSdkVersion));
		return true;
	}

	// check if the device family has changed (i.e. was universal, now iphone)
	if (manifest.deviceFamily !== this.deviceFamily) {
		this.logger.info(__('Forcing rebuild: device family changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.deviceFamily));
		this.logger.info('  ' + __('Now: %s', this.deviceFamily));
		return true;
	}

	// check the git hashes are different
	if (!manifest.gitHash || manifest.gitHash !== ti.manifest.githash) {
		this.logger.info(__('Forcing rebuild: githash changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.gitHash));
		this.logger.info('  ' + __('Now: %s', ti.manifest.githash));
		return true;
	}

	// if encryption is enabled, then we must recompile
	if (this.encryptJS) {
		this.logger.info(__('Forcing rebuild: JavaScript files need to be re-encrypted'));
		return true;
	}

	// if encryptJS changed, then we need to recompile
	if (this.encryptJS !== manifest.encryptJS) {
		this.logger.info(__('Forcing rebuild: JavaScript encryption flag changed'));
		this.logger.info('  ' + __('Was: %s', manifest.encryptJS));
		this.logger.info('  ' + __('Now: %s', this.encryptJS));
		return true;
	}

	// check if the modules hashes are different
	if (this.modulesHash !== manifest.modulesHash) {
		this.logger.info(__('Forcing rebuild: modules hash changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.modulesHash));
		this.logger.info('  ' + __('Now: %s', this.modulesHash));
		return true;
	}

	if (this.modulesNativeHash !== manifest.modulesNativeHash) {
		this.logger.info(__('Forcing rebuild: native modules hash changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.modulesNativeHash));
		this.logger.info('  ' + __('Now: %s', this.modulesNativeHash));
		return true;
	}

	// next we check if any tiapp.xml values changed so we know if we need to reconstruct the main.m
	if (this.tiapp.name !== manifest.name) {
		this.logger.info(__('Forcing rebuild: tiapp.xml project name changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.name));
		this.logger.info('  ' + __('Now: %s', this.tiapp.name));
		return true;
	}

	if (this.tiapp.id !== manifest.id) {
		this.logger.info(__('Forcing rebuild: tiapp.xml app id changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.id));
		this.logger.info('  ' + __('Now: %s', this.tiapp.id));
		return true;
	}

	if (!this.tiapp.analytics !== !manifest.analytics) {
		this.logger.info(__('Forcing rebuild: tiapp.xml analytics flag changed since last build'));
		this.logger.info('  ' + __('Was: %s', !!manifest.analytics));
		this.logger.info('  ' + __('Now: %s', !!this.tiapp.analytics));
		return true;
	}
	if (this.tiapp.publisher !== manifest.publisher) {
		this.logger.info(__('Forcing rebuild: tiapp.xml publisher changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.publisher));
		this.logger.info('  ' + __('Now: %s', this.tiapp.publisher));
		return true;
	}

	if (this.tiapp.url !== manifest.url) {
		this.logger.info(__('Forcing rebuild: tiapp.xml url changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.url));
		this.logger.info('  ' + __('Now: %s', this.tiapp.url));
		return true;
	}

	if (this.tiapp.version !== manifest.version) {
		this.logger.info(__('Forcing rebuild: tiapp.xml version changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.version));
		this.logger.info('  ' + __('Now: %s', this.tiapp.version));
		return true;
	}

	if (this.tiapp.description !== manifest.description) {
		this.logger.info(__('Forcing rebuild: tiapp.xml description changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.description));
		this.logger.info('  ' + __('Now: %s', this.tiapp.description));
		return true;
	}

	if (this.tiapp.copyright !== manifest.copyright) {
		this.logger.info(__('Forcing rebuild: tiapp.xml copyright changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.copyright));
		this.logger.info('  ' + __('Now: %s', this.tiapp.copyright));
		return true;
	}

	if (this.tiapp.guid !== manifest.guid) {
		this.logger.info(__('Forcing rebuild: tiapp.xml guid changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.guid));
		this.logger.info('  ' + __('Now: %s', this.tiapp.guid));
		return true;
	}

	if (this.forceCopy !== manifest.forceCopy) {
		this.logger.info(__('Forcing rebuild: force copy flag changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.forceCopy));
		this.logger.info('  ' + __('Now: %s', this.forceCopy));
		return true;
	}

	if (this.forceCopyAll !== manifest.forceCopyAll) {
		this.logger.info(__('Forcing rebuild: force copy all flag changed since last build'));
		this.logger.info('  ' + __('Was: %s', manifest.forceCopyAll));
		this.logger.info('  ' + __('Now: %s', this.forceCopyAll));
		return true;
	}

	return false;
};

iOSBuilder.prototype.checkIfNeedToRecompile = function checkIfNeedToRecompile(next) {
	// determine the libTiCore hash
	this.libTiCoreHash = this.hash(fs.readFileSync(path.join(this.platformPath, 'libTiCore.a')));

	// figure out all of the modules currently in use
	this.modulesHash = this.hash(this.tiapp.modules ? this.tiapp.modules.filter(function (m) {
		return !m.platform || /^iphone|ipad|ios|commonjs$/.test(m.platform);
	}).map(function (m) {
		return m.id + ',' + m.platform + ',' + m.version;
	}).join('|') : '');

	// check if we need to do a rebuild
	this.forceCleanBuild = this.checkIfShouldForceCleanBuild();
	this.forceRebuild = this.checkIfShouldForceRebuild();

	// now that we've read the build manifest, delete it so if this build
	// becomes incomplete, the next build will be a full rebuild
	fs.existsSync(this.buildManifestFile) && fs.unlinkSync(this.buildManifestFile);

	next();
};

iOSBuilder.prototype.copyDirSync = function copyDirSync(src, dest, opts) {
	appc.fs.copyDirSyncRecursive(src, dest, opts || {
		preserve: true,
		logger: this.logger.debug,
		ignoreDirs: this.ignoreDirs,
		ignoreFiles: this.ignoreFiles
	});
};

iOSBuilder.prototype.copyDirAsync = function copyDirAsync(src, dest, callback, opts) {
	appc.fs.copyDirRecursive(src, dest, callback, opts || {
		preserve: true,
		logger: this.logger.debug,
		ignoreDirs: this.ignoreDirs,
		ignoreFiles: this.ignoreFiles
	});
};

iOSBuilder.prototype.preparePhase = function preparePhase(next) {
	this.logger.info(__('Initiating prepare phase'));

	// recreate the build directory (<project dir>/build/[iphone|ios]/assets)
	fs.existsSync(this.buildAssetsDir) && wrench.rmdirSyncRecursive(this.buildAssetsDir);
	wrench.mkdirSyncRecursive(this.buildAssetsDir);

	next();
};

iOSBuilder.prototype.initBuildDir = function initBuildDir(next) {
	// perform a clean
	if (this.forceCleanBuild) {
		if (fs.existsSync(this.buildDir)) {
			this.logger.info(__('Cleaning build'));
			wrench.rmdirSyncRecursive(this.buildDir, true);
		}
		this.createXcodeProject();
		this.populateIosFiles();

	// perform a rebuild
	} else if (this.forceRebuild) {
		var xcodeBuildDir = path.join(this.buildDir, 'build');
		if (fs.existsSync(xcodeBuildDir)) {
			this.logger.info(__('Cleaning old build directory'));
			// wipe the actual Xcode build dir, not the Titanium build dir
			wrench.rmdirSyncRecursive(xcodeBuildDir, true);
			wrench.mkdirSyncRecursive(xcodeBuildDir);
		}
		this.logger.info(__('Performing full rebuild'));
		this.createXcodeProject();
		this.populateIosFiles();
	}

	// create the actual .app dir if it doesn't exist
	wrench.mkdirSyncRecursive(this.xcodeAppDir);
	wrench.mkdirSyncRecursive(path.join(this.buildDir, 'Classes'));

	next();
};

iOSBuilder.prototype.updateXCConfig = function updateXCConfig(next) {
	var configContents = [
		'TI_VERSION=' + this.titaniumSdkVersion,
		'TI_SDK_DIR=' + this.platformPath.replace(this.titaniumSdkVersion, '$(TI_VERSION)'),
		'TI_APPID=' + this.tiapp.id,
		'JSCORE_LD_FLAGS=-weak_framework JavaScriptCore',
		'TICORE_LD_FLAGS=-weak-lti_ios_profiler -weak-lti_ios_debugger -weak-lTiCore'
	];
	if (this.useJSCore) {
		configContents.push('OTHER_LDFLAGS[sdk=iphoneos*]=$(inherited) $(JSCORE_LD_FLAGS)','OTHER_LDFLAGS[sdk=iphonesimulator*]=$(inherited) $(JSCORE_LD_FLAGS)','#include "module"')
	} else {
		configContents.push('OTHER_LDFLAGS[sdk=iphoneos*]=$(inherited) $(TICORE_LD_FLAGS)','OTHER_LDFLAGS[sdk=iphonesimulator*]=$(inherited) $(TICORE_LD_FLAGS)','#include "module"')
	}
	this.logger.info(__('Updating Xcode project configuration: %s', 'project.xcconfig'.cyan));
	fs.writeFileSync(this.xcodeProjectConfigFile, configContents.join('\n') + '\n');
	next();
};

iOSBuilder.prototype.createInfoPlist = function createInfoPlist(next) {
	var src = this.projectDir + '/Info.plist',
		dest = this.buildDir + '/Info.plist',
		plist = this.infoPlist = new appc.plist(),
		iphone = this.tiapp.iphone,
		ios = this.tiapp.ios,
		defaultInfoPlist = path.join(this.platformPath, 'Info.plist'),
		fbAppId = this.tiapp.properties && this.tiapp.properties['ti.facebook.appid'] && this.tiapp.properties['ti.facebook.appid']['value'],
		iconName = this.tiapp.icon.replace(/(.+)(\..*)$/, '$1'), // note: this is basically stripping the file extension
		consts = {
			'__APPICON__': iconName,
			'__PROJECT_NAME__': this.tiapp.name,
			'__PROJECT_ID__': this.tiapp.id,
			'__URL__': this.tiapp.id,
			'__URLSCHEME__': this.tiapp.name.replace(/\./g, '_').replace(/ /g, '').toLowerCase(),
			'__ADDITIONAL_URL_SCHEMES__': fbAppId ? '<string>fb' + fbAppId + '</string>' : ''
		};

	function merge(src, dest) {
		Object.keys(src).forEach(function (prop) {
			if (!/^\+/.test(prop)) {
				if (Object.prototype.toString.call(src[prop]) === '[object Object]') {
					dest.hasOwnProperty(prop) || (dest[prop] = {});
					merge(src[prop], dest[prop]);
				} else {
					dest[prop] = src[prop];
				}
			}
		});
	}

	// default info.plist
	if (fs.existsSync(defaultInfoPlist)) {
		plist.parse(fs.readFileSync(defaultInfoPlist).toString().replace(/(__.+__)/g, function (match, key, format) {
			return consts.hasOwnProperty(key) ? consts[key] : '<!-- ' + key + ' -->'; // if they key is not a match, just comment out the key
		}));
	}

	// if the user has a Info.plist in their project directory, consider that a custom override
	if (fs.existsSync(src)) {
		this.logger.info(__('Copying custom Info.plist from project directory'));

		var custom = new appc.plist().parse(fs.readFileSync(src).toString());
		if (custom.CFBundleIdentifier !== this.tiapp.id) {
			this.logger.info(__('Forcing rebuild: custom Info.plist CFBundleIdentifier not equal to tiapp.xml <id>'));
			this.forceRebuild = true;
		}

		merge(custom, plist);
	}

	plist.UIRequiresPersistentWiFi = this.tiapp.hasOwnProperty('persistent-wifi') ? !!this.tiapp['persistent-wifi'] : false;
	plist.UIPrerenderedIcon = this.tiapp.hasOwnProperty('prerendered-icon') ? !!this.tiapp['prerendered-icon'] : false;
	plist.UIStatusBarHidden = this.tiapp.hasOwnProperty('statusbar-hidden') ? !!this.tiapp['statusbar-hidden'] : false;

	plist.UIStatusBarStyle = 'UIStatusBarStyleDefault';
	if (/opaque_black|opaque|black/.test(this.tiapp['statusbar-style'])) {
		plist.UIStatusBarStyle = 'UIStatusBarStyleBlackOpaque';
	} else if (/translucent_black|transparent|translucent/.test(this.tiapp['statusbar-style'])) {
		plist.UIStatusBarStyle = 'UIStatusBarStyleBlackTranslucent';
	}

	if (iphone) {
		if (iphone.orientations) {
			var orientationsMap = {
				'PORTRAIT': 'UIInterfaceOrientationPortrait',
				'UPSIDE_PORTRAIT': 'UIInterfaceOrientationPortraitUpsideDown',
				'LANDSCAPE_LEFT': 'UIInterfaceOrientationLandscapeLeft',
				'LANDSCAPE_RIGHT': 'UIInterfaceOrientationLandscapeRight'
			};

			Object.keys(iphone.orientations).forEach(function (key) {
				var entry = 'UISupportedInterfaceOrientations' + (key === 'ipad' ? '~ipad' : '');

				Array.isArray(plist[entry]) || (plist[entry] = []);
				iphone.orientations[key].forEach(function (name) {
					var value = orientationsMap[name.split('.').pop().toUpperCase()] || name;
					// name should be in the format Ti.UI.PORTRAIT, so pop the last part and see if it's in the map
					if (plist[entry].indexOf(value) === -1) {
						plist[entry].push(value);
					}
				});
			});
		}

		if (iphone.backgroundModes) {
			plist.UIBackgroundModes = (plist.UIBackgroundModes || []).concat(iphone.backgroundModes);
		}

		if (iphone.requires) {
			plist.UIRequiredDeviceCapabilities = (plist.UIRequiredDeviceCapabilities || []).concat(iphone.requiredFeatures);
		}

		if (iphone.types) {
			Array.isArray(plist.CFBundleDocumentTypes) || (plist.CFBundleDocumentTypes = []);
			iphone.types.forEach(function (type) {
				var types = plist.CFBundleDocumentTypes,
					match = false,
					i = 0;

				for (; i < types.length; i++) {
					if (types[i].CFBundleTypeName === type.name) {
						types[i].CFBundleTypeIconFiles = type.icon;
						types[i].LSItemContentTypes = type.uti;
						types[i].LSHandlerRank = type.owner ? 'Owner' : 'Alternate';
						match = true;
						break;
					}
				}

				if (!match) {
					types.push({
						CFBundleTypeName: type.name,
						CFBundleTypeIconFiles: type.icon,
						LSItemContentTypes: type.uti,
						LSHandlerRank: type.owner ? 'Owner' : 'Alternate'
					});
				}
			});
		}
	}

	ios && ios.plist && merge(ios.plist, plist);

	plist.CFBundleIdentifier = this.tiapp.id;

	if (this.target === 'device' && this.deviceId === 'itunes') {
		// device builds require an additional token to ensure uniqueness so that iTunes will detect an updated app to sync.
		// we drop the milliseconds from the current time so that we still have a unique identifier, but is less than 10
		// characters so iTunes 11.2 doesn't get upset.
		plist.CFBundleVersion = String(+new Date);
		this.logger.debug(__('Building for iTunes sync which requires us to set the CFBundleVersion to a unique number to trigger iTunes to update your app'));
		this.logger.debug(__('Setting Info.plist CFBundleVersion to current epoch time %s', plist.CFBundleVersion.cyan));
	} else {
		plist.CFBundleVersion = String(this.tiapp.version);
		this.logger.debug(__('Setting Info.plist CFBundleVersion to %s', plist.CFBundleVersion.cyan));
	}

	try {
		plist.CFBundleShortVersionString = appc.version.format(this.tiapp.version, 0, 3);
		this.logger.debug(__('Setting Info.plist CFBundleShortVersionString to %s', plist.CFBundleShortVersionString.cyan));
	} catch (ex) {
		plist.CFBundleShortVersionString = this.tiapp.version;
		this.logger.debug(__('Setting Info.plist CFBundleShortVersionString to %s', plist.CFBundleShortVersionString.cyan));
	}

	Array.isArray(plist.CFBundleIconFiles) || (plist.CFBundleIconFiles = []);
	['.png', '@2x.png', '-72.png', '-60.png', '-60@2x.png', '-60@3x.png', '-76.png', '-76@2x.png', '-Small-50.png', '-72@2x.png', '-Small-50@2x.png', '-Small.png', '-Small@2x.png', '-Small@3x.png', '-Small-40.png', '-Small-40@2x.png'].forEach(function (name) {
		name = iconName + name;
		if (fs.existsSync(path.join(this.projectDir, 'Resources', name)) ||
			fs.existsSync(path.join(this.projectDir, 'Resources', 'iphone', name)) ||
			fs.existsSync(path.join(this.projectDir, 'Resources', 'ios', name))) {
			if (plist.CFBundleIconFiles.indexOf(name) === -1) {
				plist.CFBundleIconFiles.push(name);
			}
		}
	}, this);

	var resourceDir = path.join(this.projectDir, 'Resources'),
		iphoneDir = path.join(resourceDir, 'iphone'),
		iosDir = path.join(resourceDir, 'ios');

	var i18nSplashScreens = [];

	ti.i18n.splashScreens(this.projectDir, this.logger).forEach(function (splashImage) {
		i18nSplashScreens.push(path.basename(splashImage));
	});

	// scan for launch images, unless the user is managing them
	if (!Array.isArray(plist.UILaunchImages) && !Array.isArray(plist['UILaunchImages~ipad'])) {
		[{
			'orientation': 'Portrait',
			'minimum-system-version': '8.0',
			'name': 'Default-Portrait',
			'subtype': '736h',
			'scale': ['3x'],
			'size': '{414, 736}'
		},
		{
			'orientation': 'Landscape',
			'minimum-system-version': '8.0',
			'name': 'Default-Landscape',
			'subtype': '736h',
			'scale': ['3x'],
			'size': '{414, 736}'
		},
		{
			'orientation': 'Portrait',
			'minimum-system-version': '8.0',
			'name': 'Default',
			'subtype': '667h',
			'scale': ['2x'],
			'size': '{375, 667}'
		},
		{
			'orientation': 'Portrait',
			'minimum-system-version': '7.0',
			'name': 'Default',
			'scale': ['1x', '2x'],
			'size': '{320, 480}'
		},
		{
			'orientation': 'Portrait',
			'minimum-system-version': '7.0',
			'name': 'Default',
			'subtype': '568h',
			'scale': ['2x'],
			'size': '{320, 568}'
		},
		{
			'orientation': 'Portrait',
			'idiom': 'ipad',
			'minimum-system-version': '7.0',
			'name': 'Default-Portrait',
			'scale': ['1x', '2x'],
			'size': '{768, 1024}'
		},
		{
			'orientation': 'Landscape',
			'idiom': 'ipad',
			'minimum-system-version': '7.0',
			'name': 'Default-Landscape',
			'scale': ['1x', '2x'],
			'size': '{768, 1024}'
		}].forEach(function (asset) {
			asset.scale.some(function (scale) {
				var key,
					basefilename = asset.name + (asset.subtype ? '-' + asset.subtype : ''),
					filename = basefilename + (scale !== '1x' ? '@' + scale : '') + '.png';

				if (i18nSplashScreens.indexOf(filename) !== -1 ||
					fs.existsSync(path.join(resourceDir, filename)) ||
					fs.existsSync(path.join(iphoneDir, filename)) ||
					fs.existsSync(path.join(iosDir, filename))) {

					key = 'UILaunchImages' + (asset.idiom === 'ipad' ? '~' + asset.idiom : '');
					Array.isArray(plist[key]) || (plist[key] = []);
					plist[key].push({
						UILaunchImageName: basefilename,
						UILaunchImageOrientation: asset.orientation,
						UILaunchImageSize: asset.size,
						UILaunchImageMinimumOSVersion: asset['minimum-system-version']
					});
					return true;
				}
			}, this);
		}, this);
	}

	var fontMap = {};

	// scan for ttf and otf font files
	(plist.UIAppFonts || []).forEach(function (f) {
		fontMap[f] = 1;
	});

	(function scanFonts(dir, isRoot) {
		fs.existsSync(dir) && fs.readdirSync(dir).forEach(function (file) {
			var p = path.join(dir, file);
			if (fs.statSync(p).isDirectory() && (!isRoot || file === 'iphone' || file === 'ios' || ti.availablePlatformsNames.indexOf(file) === -1)) {
				scanFonts(p);
			} else if (/\.(otf|ttf)$/i.test(file)) {
				fontMap['/' + p.replace(iphoneDir, '').replace(iosDir, '').replace(resourceDir, '').replace(/^\//, '')] = 1;
			}
		});
	}(resourceDir, true));

	var fonts = Object.keys(fontMap);
	fonts.length && (plist.UIAppFonts = fonts);

	// write the Info.plist
	fs.writeFile(dest, plist.toString('xml'), next);
};

iOSBuilder.prototype.createEntitlementsPlist = function createEntitlementsPlist(next) {
	// allow the project to have its own custom entitlements
	var entitlementsFile = path.join(this.projectDir, 'Entitlements.plist'),
		contents = '',
		pp;
	if (fs.existsSync(entitlementsFile)) {
		this.logger.info(__('Found custom entitlements: %s', entitlementsFile));
		contents = fs.readFileSync(entitlementsFile).toString();
	} else {
		function getPP(list, uuid) {
			for (var i = 0, l = list.length; i < l; i++) {
				if (list[i].uuid === uuid) {
					return list[i];
				}
			}
		}

		var pp;
		if (this.target === 'device') {
			pp = getPP(this.iosInfo.provisioning.development, this.provisioningProfileUUID);
		} else {
			pp = getPP(this.iosInfo.provisioning.distribution, this.provisioningProfileUUID);
			if (!pp) {
				pp = getPP(this.iosInfo.provisioning.adhoc, this.provisioningProfileUUID);
			}
		}

		var plist = new appc.plist();
		if (pp) {
			// attempt to customize it by reading provisioning profile
			(this.target === 'dist-appstore') && (plist['beta-reports-active'] = true);
			plist['get-task-allow'] = !!pp.getTaskAllow;
			pp.apsEnvironment && (plist['aps-environment'] = pp.apsEnvironment);
			plist['application-identifier'] = pp.appPrefix + '.' + this.tiapp.id;
			plist['keychain-access-groups'] = [ plist['application-identifier'] ];
		}
		contents = plist.toString('xml');
	}
	fs.writeFile(path.join(this.buildDir, 'Entitlements.plist'), contents, next);
};

iOSBuilder.prototype.createXcodeProject = function createXcodeProject() {
	var xcodeDir = path.join(this.buildDir, this.tiapp.name + '.xcodeproj'),
		namespace = (function (name) {
			name = name.replace(/-/g, '_').replace(/\W/g, '')
			return /^[0-9]/.test(name) ? 'k' + name : name;
		}(this.tiapp.name)),
		copyFileRegExps = [
			// note: order of regexps matters
			[/TitaniumViewController/g, namespace + '$ViewController'],
			[/TitaniumModule/g, namespace + '$Module'],
			[/Titanium|Appcelerator/g, namespace],
			[/titanium/g, '_' + namespace.toLowerCase()],
			[/(org|com)\.appcelerator/g, '$1.' + namespace.toLowerCase()],
			[new RegExp('\\* ' + namespace + ' ' + namespace + ' Mobile', 'g'), '* Appcelerator Titanium Mobile'],
			[new RegExp('\\* Copyright \\(c\\) \\d{4}(-\\d{4})? by ' + namespace + ', Inc\\.', 'g'), '* Copyright (c) 2009-' + (new Date).getFullYear() + ' by Appcelerator, Inc.'],
			[/(\* Please see the LICENSE included with this distribution for details.\n)(?! \*\s*\* WARNING)/g, '$1 * \n * WARNING: This is generated code. Modify at your own risk and without support.\n']
		],
		extRegExp = /\.(c|cpp|h|m|mm|pbxproj)$/,
		copyOpts = {
			preserve: true,
			logger: this.logger.debug,
			ignoreDirs: this.ignoreDirs,
			ignoreFiles: /^(bridge\.txt|libTitanium\.a|\.gitignore|\.npmignore|\.cvsignore|\.DS_Store|\._.*|[Tt]humbs.db|\.vspscc|\.vssscc|\.sublime-project|\.sublime-workspace|\.project|\.tmproj)$'/,
			callback: function (src, dest, contents, logger) {
				if (extRegExp.test(src) && src.indexOf('TiCore') === -1) {
					logger && logger(__('Processing %s', src.cyan));
					for (var i = 0, l = copyFileRegExps.length; i < l; i++) {
						contents = contents.toString().replace(copyFileRegExps[i][0], copyFileRegExps[i][1]);
					}
				}
				return contents;
			}
		};

	this.logger.info(__('Copying Xcode iOS files'));
	['Classes', 'headers'].forEach(function (dir) {
		appc.fs.copyDirSyncRecursive(
			path.join(this.platformPath, dir),
			path.join(this.buildDir, dir),
			copyOpts
		);
	}, this);

	appc.fs.copyFileSync(
		path.join(this.platformPath, this.platformName, 'Titanium_Prefix.pch'),
		path.join(this.buildDir, this.tiapp.name + '_Prefix.pch'),
		{
			logger: this.logger.debug
		}
	);

	this.logger.info(__('Creating Xcode project directory: %s', xcodeDir.cyan));
	wrench.mkdirSyncRecursive(xcodeDir);

	function injectCompileShellScript(str, sectionName, shellScript) {
		var p = 0;
		while (p !== -1) {
			p = str.indexOf('name = "' + sectionName + '"', p);
			if (p !== -1) {
				p = str.indexOf('shellScript = ', p);
				if (p !== -1) {
					str = str.substring(0, p) + 'shellScript = "' + shellScript + '";' + str.substring(str.indexOf('\n', p));
				}
			}
		}
		return str;
	}

	this.logger.info(__('Writing Xcode project data file: %s', 'Titanium.xcodeproj/project.pbxproj'.cyan));
	var proj = fs.readFileSync(path.join(this.platformPath, this.platformName, 'Titanium.xcodeproj', 'project.pbxproj')).toString();
	proj = proj.replace(/\.\.\/Classes/g, 'Classes')
		.replace(/\.\.\/Resources/g, 'Resources')
		.replace(/\.\.\/headers/g, 'headers')
		.replace(/\.\.\/lib/g, 'lib')
		.replace(/Titanium\.plist/g, 'Info.plist')
		.replace(/Titanium\-KitchenSink/g, this.tiapp.name)
		.replace(/path \= Titanium.app;/g, 'path = "' + this.tiapp.name + '.app";')
		.replace(/Titanium.app/g, this.tiapp.name + '.app')
		.replace(/PRODUCT_NAME \= ['"]?Titanium(-iPad|-universal)?['"]?/g, 'PRODUCT_NAME = "' + this.tiapp.name + '$1"') // note: there are no PRODUCT_NAMEs with -iPad and -universal
		.replace(/path \= Titanium_Prefix\.pch;/g, 'path = "' + this.tiapp.name + '_Prefix.pch";')
		.replace(/GCC_PREFIX_HEADER \= Titanium_Prefix\.pch;/g, 'GCC_PREFIX_HEADER = "' + this.tiapp.name + '_Prefix.pch";')
		.replace(/Titanium_Prefix\.pch/g, this.tiapp.name + '_Prefix.pch')
		.replace(/Titanium/g, namespace);

	proj = injectCompileShellScript(
		proj,
		'Pre-Compile',
		'export TITANIUM_PREFIX=\\"_Prefix-*\\"\\n'
		+ 'echo \\"Xcode Pre-Compile Phase: Removing $SHARED_PRECOMPS_DIR/$PROJECT$TITANIUM_PREFIX\\"\\n'
		+ 'find \\"$SHARED_PRECOMPS_DIR\\" -name \\"$PROJECT$TITANIUM_PREFIX\\" -print0 | xargs -0 rm -rf\\n'
		+ 'if [ \\"x$TITANIUM_CLI_XCODEBUILD\\" == \\"x\\" ]; then\\n'
		+ '    ' + (process.execPath || 'node') + ' \\"' + this.cli.argv.$0.replace(/^(.+\/)*node /, '') + '\\" build --platform ' + this.platformName + ' --sdk \\"' + this.titaniumSdkName + '\\" --no-prompt --no-progress-bars --no-banner --no-colors --build-only --xcode\\n'
		+ '    exit $?\\n'
		+ 'else\\n'
		+ '    echo \\"skipping pre-compile phase\\"\\n'
		+ 'fi'
	);
	proj = injectCompileShellScript(
		proj,
		'Post-Compile',
		"echo 'Xcode Post-Compile Phase: Touching important files'\\n"
		+ 'touch -c Classes/ApplicationRouting.h Classes/ApplicationRouting.m Classes/ApplicationDefaults.m Classes/ApplicationMods.m Classes/defines.h\\n'
		+ 'if [ \\"x$TITANIUM_CLI_IMAGES_OPTIMIZED\\" != \\"x\\" ]; then\\n'
		+ '    if [ -f \\"$TITANIUM_CLI_IMAGES_OPTIMIZED\\" ]; then\\n'
		+ '        echo \\"Xcode Post-Compile Phase: Image optimization finished before xcodebuild finished, continuing\\"\\n'
		+ '    else\\n'
		+ '        echo \\"Xcode Post-Compile Phase: Waiting for image optimization to complete\\"\\n'
		+ '        echo \\"Xcode Post-Compile Phase: $TITANIUM_CLI_IMAGES_OPTIMIZED\\"\\n'
		+ '        while [ ! -f \\"$TITANIUM_CLI_IMAGES_OPTIMIZED\\" ]\\n'
		+ '        do\\n'
		+ '            sleep 1\\n'
		+ '        done\\n'
		+ "        echo 'Xcode Post-Compile Phase: Image optimization complete, continuing'\\n"
		+ '    fi\\n'
		+ 'fi'
	);

	fs.writeFileSync(path.join(this.buildDir, this.tiapp.name + '.xcodeproj', 'project.pbxproj'), proj);

	this.logger.info(__('Writing Xcode module configuration: %s', 'module.xcconfig'.cyan));
	fs.writeFileSync(path.join(this.buildDir, 'module.xcconfig'), '// this is a generated file - DO NOT EDIT\n\n');
};

iOSBuilder.prototype.injectApplicationDefaults = function injectApplicationDefaults(next) {
	var file = path.join(this.buildDir, 'Classes', 'ApplicationDefaults.m'),
		exists = fs.existsSync(file),
		contents = ejs.render(fs.readFileSync(path.join(this.templatesDir, 'ApplicationDefaults.m')).toString(), {
			props: this.tiapp.properties || {},
			deployType: this.deployType,
			launchUrl: this.launchUrl
		});

	if (!exists || fs.readFileSync(file).toString() !== contents) {
		if (!exists) {
			this.logger.info(__('Forcing rebuild: ApplicationDefaults.m does not exist'));
		} else {
			this.logger.info(__('Forcing rebuild: ApplicationDefaults.m has changed since last build'));
		}
		this.forceRebuild = true;
		this.logger.info(__('Writing application defaults: %s', file.cyan));
		fs.writeFile(file, contents, next);
	} else {
		next();
	}
};

iOSBuilder.prototype.copyItunesArtwork = function copyItunesArtwork(next) {
	// note: iTunesArtwork is a png image WITHOUT the file extension and the
	// purpose of this function is to copy it from the root of the project.
	// The preferred location of this file is <project-dir>/Resources/iphone
	// or <project-dir>/platform/iphone.
	if (/device|dist\-appstore|dist\-adhoc/.test(this.target)) {
		this.logger.info(__('Copying iTunes artwork'));
		fs.readdirSync(this.projectDir).forEach(function (file) {
			var src = path.join(this.projectDir, file),
				m = file.match(/^iTunesArtwork(@2x)?$/i);
			if (m && fs.statSync(src).isFile()) {
				appc.fs.copyFileSync(src, path.join(this.xcodeAppDir, 'iTunesArtwork' + (m[1] ? m[1].toLowerCase() : '')), {
					logger: this.logger.debug
				});
			}
		}, this);
	}
	next();
};

iOSBuilder.prototype.copyGraphics = function copyGraphics(next) {
	var paths = [
			path.join(this.projectDir, 'Resources', 'iphone'),
			path.join(this.projectDir, 'Resources', 'ios'),
			path.join(this.platformPath, 'resources')
		],
		len = paths.length,
		i, src;

	for (i = 0; i < len; i++) {
		if (fs.existsSync(src = path.join(paths[i], this.tiapp.icon))) {
			appc.fs.copyFileSync(src, this.xcodeAppDir, {
				logger: this.logger.debug
			});
			break;
		}
	}

	next();
};

iOSBuilder.prototype.writeBuildManifest = function writeBuildManifest(next) {
	this.cli.createHook('build.ios.writeBuildManifest', this, function (manifest, cb) {
		fs.existsSync(this.buildDir) || wrench.mkdirSyncRecursive(this.buildDir);
		fs.existsSync(this.buildManifestFile) && fs.unlinkSync(this.buildManifestFile);
		fs.writeFile(this.buildManifestFile, JSON.stringify(this.buildManifest = manifest, null, '\t'), cb);
	})({
		target: this.target,
		deployType: this.deployType,
		iosSdkVersion: this.iosSdkVersion,
		deviceFamily: this.deviceFamily,
		developerName: this.certDeveloperName,
		distributionName: this.certDistributionName,
		iosSdkPath: this.platformPath,
		tiCoreHash: this.libTiCoreHash,
		modulesHash: this.modulesHash,
		modulesNativeHash: this.modulesNativeHash,
		gitHash: ti.manifest.githash,
		outputDir: this.cli.argv['output-dir'],
		name: this.tiapp.name,
		id: this.tiapp.id,
		analytics: this.tiapp.analytics,
		publisher: this.tiapp.publisher,
		url: this.tiapp.url,
		version: this.tiapp.version,
		description: this.tiapp.description,
		copyright: this.tiapp.copyright,
		guid: this.tiapp.guid,
		skipJSMinification: !!this.cli.argv['skip-js-minify'],
		forceCopy: !!this.forceCopy,
		forceCopyAll: !!this.forceCopyAll,
		encryptJS: !!this.encryptJS
	}, next);
};

iOSBuilder.prototype.compileI18NFiles = function compileI18NFiles(next) {
	var data = ti.i18n.load(this.projectDir, this.logger);

	parallel(this,
		Object.keys(data).map(function (lang) {
			return function (done) {
				var contents = [
						'/**',
						' * Appcelerator Titanium',
						' * this is a generated file - DO NOT EDIT',
						' */',
						''
					],
					dir = path.join(this.xcodeAppDir, lang + '.lproj'),
					tasks = [];

				wrench.mkdirSyncRecursive(dir);

				function add(obj, filename, map) {
					obj && tasks.push(function (next) {
						var dest = path.join(dir, filename);
						fs.writeFileSync(dest, contents.concat(Object.keys(obj).map(function (name) {
							return '"' + (map && map[name] || name).replace(/\\"/g, '"').replace(/"/g, '\\"') +
								'" = "' + (''+obj[name]).replace(/%s/g, '%@').replace(/\\"/g, '"').replace(/"/g, '\\"') + '";';
						})).join('\n'));
						if (this.compileI18N) {
							appc.subprocess.run('/usr/bin/plutil', ['-convert', 'binary1', dest], function (code, out, err) {
								next();
							});
						} else {
							next();
						}
					});
				}

				add(data[lang].app, 'InfoPlist.strings', { appname: 'CFBundleDisplayName' });
				add(data[lang].strings, 'Localizable.strings');

				parallel(this, tasks, done);
			};
		}, this),
		next
	);
};

iOSBuilder.prototype.copyLocalizedSplashScreens = function copyLocalizedSplashScreens(next) {
	ti.i18n.splashScreens(this.projectDir, this.logger).forEach(function (splashImage) {
		var token = splashImage.split('/'),
			file = token.pop(),
			lang = token.pop(),
			lprojDir = path.join(this.xcodeAppDir, lang + '.lproj'),
			globalFile = path.join(this.xcodeAppDir, file);

		// this would never need to run. But just to be safe
		if (!fs.existsSync(lprojDir)) {
			this.logger.debug(__('Creating lproj folder %s', lprojDir.cyan));
			wrench.mkdirSyncRecursive(lprojDir);
		}

		// check for it in the root of the xcode build folder
		if (fs.existsSync(globalFile)) {
			this.logger.debug(__('Removing File %s, as it is being localized', globalFile.cyan));
			fs.unlinkSync(globalFile);
		}

		appc.fs.copyFileSync(splashImage, lprojDir, {
			logger: this.logger.debug
		});
	}, this);
	next();
};

iOSBuilder.prototype.injectModulesIntoXcodeProject = function injectModulesIntoXcodeProject(next) {
	if (!this.nativeLibModules.length) {
		return next();
	}

	var projectFile = path.join(this.buildDir, this.tiapp.name + '.xcodeproj', 'project.pbxproj'),
		projectOrigContents = fs.readFileSync(projectFile).toString(),
		projectContents = projectOrigContents;
		targetLibs = [];

	this.nativeLibModules.forEach(function (lib) {
		projectContents.indexOf(lib.libName) === -1 && targetLibs.push(lib);
	}, this);

	if (targetLibs.length) {
		// we have some libraries to add to the project file
		this.logger.info(__('Injecting native libraries into Xcode project file'));

		var fileMarkers = [],
			fileMarkers2FileRefs = {},
			refMarkers = [],
			frameworkMarkers = [],
			groupMarkers = [],
			groupUUID;

		function makeUUID() {
			return uuid.v4().toUpperCase().replace(/-/g, '').substring(0, 24);
		}

		projectContents.split('\n').forEach(function (line) {
			line.indexOf('/* libTiCore.a */;') !== -1 && fileMarkers.push(line);
			line.indexOf('/* libTiCore.a */ =') !== -1 && refMarkers.push(line);
			line.indexOf('/* libTiCore.a in Frameworks */,') !== -1 && frameworkMarkers.push(line);
			line.indexOf('/* libTiCore.a */,') !== -1 && groupMarkers.push(line);
		});

		fileMarkers.forEach(function (marker) {
			var m = marker.match(/([0-9a-zA-Z]+) \/\*/);
			if (m) {
				fileMarkers2FileRefs[m[1].trim()] = makeUUID();
				!groupUUID && (m = marker.match(/fileRef \= ([0-9a-zA-Z]+) /)) && (groupUUID = m[1]);
			}
		});

		targetLibs.forEach(function (lib) {
			var newGroupUUID = makeUUID();

			fileMarkers.forEach(function (marker) {
				var begin = projectContents.indexOf(marker),
					end = begin + marker.length,
					m = marker.match(/([0-9a-zA-Z]+) \/\*/),
					newUUID = makeUUID(),
					line = projectContents
						.substring(begin, end)
						.replace(/libTiCore\.a/g, lib.libName)
						.replace(new RegExp(groupUUID, 'g'), newGroupUUID)
						.replace(new RegExp(m[1].trim(), 'g'), newUUID);
				fileMarkers2FileRefs[m[1].trim()] = newUUID;
				projectContents = projectContents.substring(0, end) + '\n' + line + '\n' + projectContents.substring(end + 1);
			});

			refMarkers.forEach(function (marker) {
				var begin = projectContents.indexOf(marker),
					end = begin + marker.length,
					m = marker.match(/([0-9a-zA-Z]+) \/\*/),
					line = projectContents
						.substring(begin, end)
						.replace(/lib\/libTiCore\.a/g, '"' + lib.libFile.replace(/"/g, '\\"') + '"')
						.replace(/libTiCore\.a/g, lib.libName)
						.replace(/SOURCE_ROOT/g, '"<absolute>"')
						.replace(new RegExp(m[1].trim(), 'g'), newGroupUUID);
				projectContents = projectContents.substring(0, end) + '\n' + line + '\n' + projectContents.substring(end + 1);
			});

			groupMarkers.forEach(function (marker) {
				var begin = projectContents.indexOf(marker),
					end = begin + marker.length,
					line = projectContents
						.substring(begin, end)
						.replace(/libTiCore\.a/g, lib.libName)
						.replace(new RegExp(groupUUID, 'g'), newGroupUUID);
				projectContents = projectContents.substring(0, end) + '\n' + line + '\n' + projectContents.substring(end + 1);
			});

			frameworkMarkers.forEach(function (marker) {
				var begin = projectContents.indexOf(marker),
					end = begin + marker.length,
					m = marker.match(/([0-9a-zA-Z]+) \/\*/),
					line = projectContents
						.substring(begin, end)
						.replace(/libTiCore\.a/g, lib.libName)
						.replace(new RegExp(m[1].trim(), 'g'), fileMarkers2FileRefs[m[1].trim()]);
				projectContents = projectContents.substring(0, end) + '\n' + line + '\n' + projectContents.substring(end + 1);
			});

			(function (libPath) {
				var begin = projectContents.indexOf(libPath),
					end, line;
				while (begin !== -1) {
					end = begin + libPath.length;
					line = projectContents.substring(begin, end).replace(libPath, '"\\"' + path.dirname(lib.libFile) + '\\"",');
					projectContents = projectContents.substring(0, end) + '\n                                        ' +  line + '\n' + projectContents.substring(end + 1);
					begin = projectContents.indexOf(libPath, end + line.length);
				}
			}('"\\"$(SRCROOT)/lib\\"",'));
		}, this);

		if (projectContents !== projectOrigContents) {
			this.logger.debug(__('Writing %s', projectFile.cyan));
			fs.writeFileSync(projectFile, projectContents);
		}
	}

	next();
};

iOSBuilder.prototype.injectExtensionsIntoXcodeProject = function injectExtensionsIntoXcodeProject(next) {
	if (!this.builtExtensions.length) {
		return next();
	}

	var projectFile = path.join(this.buildDir, this.tiapp.name + '.xcodeproj', 'project.pbxproj'),
		projectOrigContents = fs.readFileSync(projectFile).toString(),
		projectContents = projectOrigContents;
		targetExts = [],
		tabs = '\t\t\t\t'; // Tabs aren't necessary, just makes it pretty

	this.builtExtensions.forEach(function (ext) {
		projectContents.indexOf(ext.extensionName) === -1 && targetExts.push(ext);
	}, this);

	if (targetExts.length) {
		// we have some extensions to add to the project file
		this.logger.info(__('Injecting native extensions into Xcode project file'));

		targetExts.forEach(function (ext) {
			// Find locations
			var fileMarkers = [],
				refMarkers = [],
				groupMarkers = [],
				copyFilesBuildPhaseMarkers = [],
				groupUUID,
				newGroupUUID = makeUUID(),
				fileIndex = -1;

			function makeUUID() {
				return uuid.v4().toUpperCase().replace(/-/g, '').substring(0, 24);
			}

			projectContents.split('\n').forEach(function (line) {
				line.indexOf('/* libTiCore.a */;') !== -1 && fileMarkers.push(line);
				line.indexOf('/* libTiCore.a */ =') !== -1 && refMarkers.push(line);
			});

			var groupMatch = projectContents.match(/\* Extensions \*\/ = {[^}]*};/);
			groupMatch && groupMarkers.push(groupMatch[0]);

			var copyFilesBuildPhaseMatch = projectContents.match(/\/\* Embed App Extensions \*\/ = {\s+isa = PBXCopyFilesBuildPhase;[^}]*};/g);
			copyFilesBuildPhaseMatch && copyFilesBuildPhaseMatch.forEach(function(match) {
				copyFilesBuildPhaseMarkers.push(match);
			});

			fileMarkers.forEach(function (marker) {
				var m = marker.match(/([0-9a-zA-Z]+) \/\*/);
				if (m) {
					!groupUUID && (m = marker.match(/fileRef \= ([0-9a-zA-Z]+) /)) && (groupUUID = m[1]);
				}
			});

			// Inject files
			fileMarkers.forEach(function (marker) {
				fileIndex++;
				if (fileIndex >= copyFilesBuildPhaseMarkers.length) {
					this.logger.error('Error injecting extension into Xcode project (BuildPhase markers not found or invalid)');
					process.exit(1);
				}

				// Add file references for the extension in Resources
				var begin = projectContents.indexOf(marker),
					end = begin + marker.length,
					m = marker.match(/([0-9a-zA-Z]+) \/\*/),
					newUUID = makeUUID(),
					line = projectContents
						.substring(begin, end)
						.replace(/libTiCore\.a/g, ext.extensionName)
						.replace(/in Frameworks/g, 'in Resources')
						.replace(new RegExp(groupUUID, 'g'), newGroupUUID)
						.replace(new RegExp(m[1].trim(), 'g'), newUUID);
				projectContents = projectContents.substring(0, end) + '\n' + line + '\n' + projectContents.substring(end + 1);

				// Add file references for the extension in Embed App Extensions Build Phase
				var begin = projectContents.indexOf(marker),
					end = begin + marker.length,
					m = marker.match(/([0-9a-zA-Z]+) \/\*/),
					newUUID = makeUUID(),
					line = projectContents
						.substring(begin, end)
						.replace(/libTiCore\.a/g, ext.extensionName)
						.replace(/in Frameworks/g, 'in Embed App Extensions')
						.replace(new RegExp(groupUUID, 'g'), newGroupUUID)
						.replace(new RegExp(m[1].trim(), 'g'), newUUID)
						.replace(new RegExp(ext.extensionName + ' \\*/;', 'g'), ext.extensionName + ' */; settings = {ATTRIBUTES = (RemoveHeadersOnCopy, ); };');
				projectContents = projectContents.substring(0, end) + '\n' + line + '\n' + projectContents.substring(end + 1);

				var buildMarker = copyFilesBuildPhaseMarkers[fileIndex];
				addFileToBuildPhase(buildMarker, newUUID, 'Embed App Extensions');

			}, this);

			function addFileToBuildPhase(marker, uuid, inWhere) {
				var begin = projectContents.indexOf(marker),
					end = begin + marker.length,
					line = projectContents
						.substring(begin, end)
						.replace(/files = \(/g, 'files = (\n' + tabs + uuid + ' /* ' + ext.extensionName + ' in ' + inWhere + ' */,');
				projectContents = projectContents.substring(0, begin) + line + '\n' + projectContents.substring(end + 1);
			}

			refMarkers.forEach(function (marker) {
				var begin = projectContents.indexOf(marker),
					end = begin + marker.length,
					m = marker.match(/([0-9a-zA-Z]+) \/\*/),
					line = projectContents
						.substring(begin, end)
						.replace(/archive.ar/g, '\"wrapper.app-extension\"')
						.replace(/lib\/libTiCore\.a/g, '"' + ext.extensionFile.replace(/"/g, '\\"') + '"')
						.replace(/name = libTiCore.a/g, 'name = "' + ext.extensionName+ '"') // File names with spaces need quotes
						.replace(/libTiCore\.a/g, ext.extensionName)
						.replace(/SOURCE_ROOT/g, '"<group>"')
						.replace(new RegExp(m[1].trim(), 'g'), newGroupUUID);
				projectContents = projectContents.substring(0, end) + '\n' + line + '\n' + projectContents.substring(end + 1);
			});

			groupMarkers.forEach(function (marker) {
				var begin = projectContents.indexOf(marker),
					end = begin + marker.length,
					line = projectContents
						.substring(begin, end)
						.replace(/children = \(/g, 'children = (\n' + tabs + newGroupUUID + ' /* ' + ext.extensionName + ' */,');
				projectContents = projectContents.substring(0, begin) + line + '\n' + projectContents.substring(end + 1);
			});

		}, this);
	}

	if (projectContents !== projectOrigContents) {
		this.logger.debug(__('Writing %s', projectFile.cyan));
		fs.writeFileSync(projectFile, projectContents);
	}

	next();
};

iOSBuilder.prototype.populateIosFiles = function populateIosFiles(next) {
	var consts = {
			'__PROJECT_NAME__': this.tiapp.name,
			'__PROJECT_ID__': this.tiapp.id,
			'__DEPLOYTYPE__': this.deployType,
			'__APP_ID__': this.tiapp.id,
			'__APP_ANALYTICS__': '' + (this.tiapp.hasOwnProperty('analytics') ? !!this.tiapp.analytics : true),
			'__APP_PUBLISHER__': this.tiapp.publisher,
			'__APP_URL__': this.tiapp.url,
			'__APP_NAME__': this.tiapp.name,
			'__APP_VERSION__': this.tiapp.version,
			'__APP_DESCRIPTION__': this.tiapp.description,
			'__APP_COPYRIGHT__': this.tiapp.copyright,
			'__APP_GUID__': this.tiapp.guid,
			'__APP_RESOURCE_DIR__': '',
			'__APP_DEPLOY_TYPE__': this.buildType
		},
		dest,
		variables = {},
		mainContents = fs.readFileSync(path.join(this.platformPath, 'main.m')).toString().replace(/(__.+?__)/g, function (match, key, format) {
			var s = consts.hasOwnProperty(key) ? consts[key] : key;
			return typeof s === 'string' ? s.replace(/"/g, '\\"').replace(/\n/g, '\\n') : s;
		}),
		xcconfigContents = [
			'// this is a generated file - DO NOT EDIT',
			''
		];

	dest = path.join(this.buildDir, 'main.m');
	if (!fs.existsSync(dest) || fs.readFileSync(dest).toString() !== mainContents) {
		this.logger.debug(__('Writing %s', dest.cyan));
		fs.writeFileSync(dest, mainContents);
	}

	if (this.modules.length) {
		// add the modules to the xcconfig file
		this.modules.forEach(function (m) {
			var moduleId = m.manifest.moduleid.toLowerCase(),
				moduleName = m.manifest.name.toLowerCase(),
				prefix = m.manifest.moduleid.toUpperCase().replace(/\./g, '_');

			[	path.join(m.modulePath, 'module.xcconfig'),
				path.join(this.projectDir, 'modules', 'iphone', moduleName + '.xcconfig')
			].forEach(function (file) {
				if (fs.existsSync(file)) {
					var xc = new appc.xcconfig(file);
					Object.keys(xc).forEach(function (key) {
						var name = (prefix + '_' + key).replace(/[^\w]/g, '_');
						variables[key] || (variables[key] = []);
						variables[key].push(name);
						xcconfigContents.push((name + '=' + xc[key]).replace(new RegExp('\$\(' + key + '\)', 'g'), '$(' + name + ')'));
					});
				}
			});
		}, this);

		// write the ApplicationMods.m file
		var applicationModsContents = ejs.render(fs.readFileSync(path.join(this.templatesDir, 'ApplicationMods.m')).toString(), {
				modules: this.modules
			}),
			applicationModsFile = path.join(this.buildDir, 'Classes', 'ApplicationMods.m');
		if (!fs.existsSync(applicationModsFile) || fs.readFileSync(applicationModsFile).toString() !== applicationModsContents) {
			this.logger.debug(__('Writing application modules source file: %s', applicationModsFile.cyan));
			fs.writeFileSync(applicationModsFile, applicationModsContents);
		} else {
			this.logger.debug(__('Application modules source file already up-to-date: %s', applicationModsFile.cyan));
		}
	}

	// write the module.xcconfig file
	Object.keys(variables).forEach(function (v) {
		xcconfigContents.push(v + '=$(inherited) ' + variables[v].map(function (x) { return '$(' + x + ') '; }).join(''));
	});
	xcconfigContents = xcconfigContents.join('\n');

	dest = path.join(this.buildDir, 'module.xcconfig');
	if (!fs.existsSync(dest) || fs.readFileSync(dest).toString() !== xcconfigContents) {
		this.logger.debug(__('Writing module xcconfig file: %s', dest.cyan));
		fs.writeFileSync(dest, xcconfigContents);
	} else {
		this.logger.debug(__('Module xccconfig file already up-to-date: %s', dest.cyan));
	}
};

iOSBuilder.prototype.copyTitaniumLibraries = function copyTitaniumLibraries(next) {
	// check to see if the symlink exists and that it points to the right version of the library
	var dir = path.join(this.buildDir, 'lib'),
		dest;

	wrench.mkdirSyncRecursive(dir);

	dest = path.join(dir, 'libTiCore.a');
	if (this.cli.argv['force-copy-all']) {
		fs.existsSync(dest) || appc.fs.copyFileSync(path.join(this.platformPath, 'libTiCore.a'), dest, { logger: this.logger.debug });
	} else {
		if (!fs.existsSync(dest) || !fs.lstatSync(dest).isSymbolicLink() || fs.readlinkSync(dest).indexOf(this.titaniumSdkVersion) === -1) {
			try {
				fs.unlinkSync(dest);
			} catch (e) {}
			fs.symlinkSync(path.join(this.platformPath, 'libTiCore.a'), dest);
		}
	}

	dest = path.join(dir, 'libtiverify.a');
	fs.existsSync(dest) || appc.fs.copyFileSync(path.join(this.platformPath, 'libtiverify.a'), dest, { logger: this.logger.debug });

	dest = path.join(dir, 'libti_ios_debugger.a');
	fs.existsSync(dest) || appc.fs.copyFileSync(path.join(this.platformPath, 'libti_ios_debugger.a'), dest, { logger: this.logger.debug });

	dest = path.join(dir, 'libti_ios_profiler.a');
	fs.existsSync(dest) || appc.fs.copyFileSync(path.join(this.platformPath, 'libti_ios_profiler.a'), dest, { logger: this.logger.debug });

	next();
};

iOSBuilder.prototype.compileJSSFiles = function compileJSSFiles(next) {
	ti.jss.load(path.join(this.projectDir, 'Resources'), this.deviceFamilyNames[this.deviceFamily], this.logger, function (results) {
		var appStylesheet = path.join(this.xcodeAppDir, 'stylesheet.plist'),
			plist = new appc.plist();
		appc.util.mix(plist, results);
		fs.writeFile(appStylesheet, plist.toString('xml'), function () {
			if (this.compileJSS) {
				// compile plist into binary format so it's faster to load, we can be slow on simulator
				appc.subprocess.run('/usr/bin/plutil', ['-convert', 'binary1', appStylesheet], function (code, out, err) {
					next();
				});
			} else {
				next();
			}
		}.bind(this));
	}.bind(this));
};

iOSBuilder.prototype.validateExtentions = function validateExtentions(next) {
	this.extensionsToBuild = [];
	this.builtExtensions = [];

	if (this.tiapp.extensions) {
		this.tiapp.extensions.forEach(function (ext) {
			if (!ext.projectPath) {
				this.logger.error(__('Extensions must have a "projectPath" attribute that points to a folder containing an Xcode project'));
				process.exit(1);
			}

			if (!fs.existsSync(appc.fs.resolvePath(ext.projectPath))) {
				this.logger.error(__('Extension projectPath %s location does not exist', ext.projectPath.cyan));
				process.exit(1);
			}

			if (!ext.target) {
				this.logger.error(__('Extension with projectPath %s does not have a target as its value', ext.projectPath.cyan));
				process.exit(1);
			}

			this.extensionsToBuild.push(ext);
		}.bind(this));
	}
	next();
};

iOSBuilder.prototype.invokeXcodeBuildOnExtensionDependencies = function invokeXcodeBuildOnExtensionDependencies(next) {
	if (!this.extensionsToBuild.length) {
		return next();
	}
	this.logger.info(__('Invoking xcodebuild on extension dependencies'));

	var projectsToBuild = this.extensionsToBuild,
		buildIndex = 0;

	var buildNextProject = function buildNextProject() {
		if (projectsToBuild.length <= buildIndex) {
			return next();
		}

		var tiProjectDir = process.cwd(),
			proj = projectsToBuild[buildIndex++],
			projectAbsolutePath = appc.fs.resolvePath(proj.projectPath),
			xcodeBuildDirectory = path.join(projectAbsolutePath,'build');

		process.chdir(projectAbsolutePath);

		var xcodeArgs = [
			'-target', proj.target,
			'-configuration', this.xcodeTarget,
			'-sdk', this.xcodeTargetOS,
			'TARGETED_DEVICE_FAMILY=' + this.deviceFamilies[this.deviceFamily],
			'ONLY_ACTIVE_ARCH=NO',
			'DEAD_CODE_STRIPPING=YES'
		],
		gccDefs = [ 'DEPLOYTYPE=' + this.deployType ];

		if (this.target === 'simulator') {
			gccDefs.push('__LOG__ID__=' + this.tiapp.guid);
			gccDefs.push('DEBUG=1');
			gccDefs.push('TI_VERSION=' + this.titaniumSdkVersion);
		}

		if (/simulator|device|dist\-adhoc/.test(this.target)) {
			this.tiapp.ios && this.tiapp.ios.enablecoverage && gccDefs.push('KROLL_COVERAGE=1');
		}

		xcodeArgs.push('GCC_PREPROCESSOR_DEFINITIONS=' + gccDefs.join(' '));

		if (/device|dist\-appstore|dist\-adhoc/.test(this.target)) {
			xcodeArgs.push('DEPLOYMENT_POSTPROCESSING=YES');
			if (this.keychain) {
				xcodeArgs.push('OTHER_CODE_SIGN_FLAGS=--keychain ' + this.keychain);
			}
		}

		var keychains = this.iosInfo.certs.keychains;

		if (this.target === 'device') {
			Object.keys(keychains).some(function (keychain) {
				return (keychains[keychain].developer || []).some(function (d) {
					if (!d.invalid && d.name === this.certDeveloperName) {
						xcodeArgs.push('CODE_SIGN_IDENTITY=' + d.fullname);
						return true;
					}
				}, this);
			}, this);
		}

		if (/dist-appstore|dist\-adhoc/.test(this.target)) {
			Object.keys(keychains).some(function (keychain) {
				return (keychains[keychain].developer || []).some(function (d) {
					if (!d.invalid && d.name === this.certDistributionName) {
						xcodeArgs.push('CODE_SIGN_IDENTITY=' + d.fullname);
						return true;
					}
				}, this);
			}, this);
		}

		var xcodebuildHook = this.cli.createHook('build.ios.xcodebuild', this, function (exe, args, opts, done) {

			var p = spawn(exe, args, opts),
				out = [],
				err = [],
				stopOutputting = false;

			p.stdout.on('data', function (data) {
				data.toString().split('\n').forEach(function (line) {
					if (line.length) {
						out.push(line);
						if (line.indexOf('Failed to minify') !== -1) {
							stopOutputting = true;
						}
						if (!stopOutputting) {
							this.logger.trace(line);
						}
					}
				}, this);
			}.bind(this));

			p.stderr.on('data', function (data) {
				data.toString().split('\n').forEach(function (line) {
					if (line.length) {
						err.push(line);
					}
				}, this);
			}.bind(this));

			p.on('close', function (code, signal) {
				if (code) {
					// first see if we errored due to a dependency issue
					if (err.join('\n').indexOf('Check dependencies') !== -1) {
						var len = out.length;
						for (var i = len - 1; i >= 0; i--) {
							if (out[i].indexOf('Check dependencies') !== -1) {
								if (out[out.length - 1].indexOf('Command /bin/sh failed with exit code') !== -1) {
									len--;
								}
								for (var j = i + 1; j < len; j++) {
									this.logger.error(__('Error details: %s', out[j]));
								}
								this.logger.log();
								process.exit(1);
							}
						}
					}

					// next see if it was a minification issue
					var len = out.length;
					for (var i = len - 1, k = 0; i >= 0 && k < 10; i--, k++) {
						if (out[i].indexOf('Failed to minify') !== -1) {
							if (out[out.length - 1].indexOf('Command /bin/sh failed with exit code') !== -1) {
								len--;
							}
							while (i < len) {
								this.logger.log(out[i++]);
							}
							this.logger.log();
							process.exit(1);
						}
					}

					// just print the entire error buffer
					err.forEach(function (line) {
						this.logger.error(line);
					}, this);
					this.logger.log();
					process.exit(1);
				}

				// end of the line
				done(code);
			}.bind(this));
		});

		this.logger.info(__('Building target: %s at: %s', proj.target.cyan, process.cwd().cyan));

		xcodebuildHook(
			this.xcodeEnv.executables.xcodebuild,
			xcodeArgs,
			{
				cwd: proj.projec,
				env: {
					DEVELOPER_DIR: this.xcodeEnv.path,
					TMPDIR: process.env.TMPDIR,
					HOME: process.env.HOME,
					PATH: process.env.PATH,
					TITANIUM_CLI_XCODEBUILD: 'Enjoy hacking? http://jobs.appcelerator.com/',
					TITANIUM_CLI_IMAGES_OPTIMIZED: this.target === 'simulator' ? '' : this.imagesOptimizedFile
				}
			},
			function() {
				var productPath = path.join(xcodeBuildDirectory, this.xcodeTarget + '-' + (this.target === 'simulator' ? 'iphonesimulator' : 'iphoneos')),
					productFileName = proj.target + '.appex';
				this.builtExtensions.push({
					extensionName: productFileName,
					extensionFile: path.join(productPath, productFileName)
				});

				process.chdir(tiProjectDir);
				buildNextProject.call(this);
			}.bind(this)
		);
	};

	buildNextProject.call(this);
};

iOSBuilder.prototype.invokeXcodeBuild = function invokeXcodeBuild(next) {
	this.logger.info(__('Invoking xcodebuild'));

	var xcodeArgs = [
			'-target', this.tiapp.name + this.xcodeTargetSuffixes[this.deviceFamily],
			'-configuration', this.xcodeTarget,
			'-sdk', this.xcodeTargetOS,
			'IPHONEOS_DEPLOYMENT_TARGET=' + appc.version.format(this.minIosVer, 2),
			'TARGETED_DEVICE_FAMILY=' + this.deviceFamilies[this.deviceFamily],
			//'VALID_ARCHS=' + this.architectures,
			'ONLY_ACTIVE_ARCH=NO',
			'DEAD_CODE_STRIPPING=YES'
		],
		gccDefs = [ 'DEPLOYTYPE=' + this.deployType ];

	if (this.target === 'simulator') {
		gccDefs.push('__LOG__ID__=' + this.tiapp.guid);
		gccDefs.push('DEBUG=1');
		gccDefs.push('TI_VERSION=' + this.titaniumSdkVersion);
	}

	if (/simulator|device|dist\-adhoc/.test(this.target)) {
		this.tiapp.ios && this.tiapp.ios.enablecoverage && gccDefs.push('KROLL_COVERAGE=1');
	}

	xcodeArgs.push('GCC_PREPROCESSOR_DEFINITIONS=' + gccDefs.join(' '));

	if (/device|dist\-appstore|dist\-adhoc/.test(this.target)) {
		xcodeArgs.push('PROVISIONING_PROFILE=' + this.provisioningProfileUUID);
		xcodeArgs.push('DEPLOYMENT_POSTPROCESSING=YES');
		if (this.keychain) {
			xcodeArgs.push('OTHER_CODE_SIGN_FLAGS=--keychain ' + this.keychain);
		}
	}

	var keychains = this.iosInfo.certs.keychains;

	if (this.target === 'device') {
		Object.keys(keychains).some(function (keychain) {
			return (keychains[keychain].developer || []).some(function (d) {
				if (!d.invalid && d.name === this.certDeveloperName) {
					xcodeArgs.push('CODE_SIGN_IDENTITY=' + d.fullname);
					return true;
				}
			}, this);
		}, this);
	}

	if (/dist-appstore|dist\-adhoc/.test(this.target)) {
		Object.keys(keychains).some(function (keychain) {
			return (keychains[keychain].developer || []).some(function (d) {
				if (!d.invalid && d.name === this.certDistributionName) {
					xcodeArgs.push('CODE_SIGN_IDENTITY=' + d.fullname);
					return true;
				}
			}, this);
		}, this);
	}

	var xcodebuildHook = this.cli.createHook('build.ios.xcodebuild', this, function (exe, args, opts, done) {
			var p = spawn(exe, args, opts),
				out = [],
				err = [],
				stopOutputting = false;

			p.stdout.on('data', function (data) {
				data.toString().split('\n').forEach(function (line) {
					if (line.length) {
						out.push(line);
						if (line.indexOf('Failed to minify') !== -1) {
							stopOutputting = true;
						}
						if (!stopOutputting) {
							this.logger.trace(line);
						}
					}
				}, this);
			}.bind(this));

			p.stderr.on('data', function (data) {
				data.toString().split('\n').forEach(function (line) {
					if (line.length) {
						err.push(line);
					}
				}, this);
			}.bind(this));

			p.on('close', function (code, signal) {
				if (code) {
					// first see if we errored due to a dependency issue
					if (err.join('\n').indexOf('Check dependencies') !== -1) {
						var len = out.length;
						for (var i = len - 1; i >= 0; i--) {
							if (out[i].indexOf('Check dependencies') !== -1) {
								if (out[out.length - 1].indexOf('Command /bin/sh failed with exit code') !== -1) {
									len--;
								}
								for (var j = i + 1; j < len; j++) {
									this.logger.error(__('Error details: %s', out[j]));
								}
								this.logger.log();
								process.exit(1);
							}
						}
					}

					// next see if it was a minification issue
					var len = out.length;
					for (var i = len - 1, k = 0; i >= 0 && k < 10; i--, k++) {
						if (out[i].indexOf('Failed to minify') !== -1) {
							if (out[out.length - 1].indexOf('Command /bin/sh failed with exit code') !== -1) {
								len--;
							}
							while (i < len) {
								this.logger.log(out[i++]);
							}
							this.logger.log();
							process.exit(1);
						}
					}

					// just print the entire error buffer
					err.forEach(function (line) {
						this.logger.error(line);
					}, this);
					this.logger.log();
					process.exit(1);
				}

				// end of the line
				done(code);
			}.bind(this));
		});

	xcodebuildHook(
		this.xcodeEnv.executables.xcodebuild,
		xcodeArgs,
		{
			cwd: this.buildDir,
			env: {
				DEVELOPER_DIR: this.xcodeEnv.path,
				TMPDIR: process.env.TMPDIR,
				HOME: process.env.HOME,
				PATH: process.env.PATH,
				TITANIUM_CLI_XCODEBUILD: 'Enjoy hacking? http://jobs.appcelerator.com/',
				TITANIUM_CLI_IMAGES_OPTIMIZED: this.target === 'simulator' ? '' : this.imagesOptimizedFile
			}
		},
		next
	);
};

iOSBuilder.prototype.xcodePrecompilePhase = function xcodePrecompilePhase(finished) {
	this.logger.info(__('Initiating Xcode pre-compile phase'));

	series(this, [
		'copyResources',
		'processTiSymbols',
		'writeDebugProfilePlists',
		'compileJSSFiles',
		'compileI18NFiles',
		'copyLocalizedSplashScreens',
		function (next) {
			// if not production and running from Xcode
			if (this.deployType !== 'production') {
				var appDefaultsFile = path.join(this.buildDir, 'Classes', 'ApplicationDefaults.m');
				fs.writeFileSync(appDefaultsFile, fs.readFileSync(appDefaultsFile).toString().replace(/return \[NSDictionary dictionaryWithObjectsAndKeys\:\[TiUtils stringValue\:@".+"\], @"application-launch-url", nil];/, 'return nil;'));
			}
			next();
		}
	], function () {
		finished();
	});
};

iOSBuilder.prototype.writeDebugProfilePlists = function writeDebugProfilePlists(next) {
	function processPlist(filename, host) {
		var dest = path.join(this.xcodeAppDir, filename),
			parts = (host || '').split(':');

		fs.writeFileSync(dest, ejs.render(fs.readFileSync(path.join(this.templatesDir, filename)).toString(), {
			host: parts.length > 0 ? parts[0] : '',
			port: parts.length > 1 ? parts[1] : '',
			airkey: parts.length > 2 ? parts[2] : '',
			hosts: parts.length > 3 ? parts[3] : ''
		}));
	}

	processPlist.call(this, 'debugger.plist', this.debugHost);
	processPlist.call(this, 'profiler.plist', this.profilerHost);

	next();
};

iOSBuilder.prototype.copyResources = function copyResources(finished) {
	var ignoreDirs = this.ignoreDirs,
		ignoreFiles = this.ignoreFiles,
		extRegExp = /\.(\w+)$/,
		icon = (this.tiapp.icon || 'appicon.png').match(/^(.*)\.(.+)$/),
		unsymlinkableFileRegExp = new RegExp("^Default.*\.png|.+\.(otf|ttf)|iTunesArtwork" + (icon ? '|' + icon[1].replace(/\./g, '\\.') + '.*\\.' + icon[2] : '') + "$"),
		jsFiles = {},
		jsFilesToEncrypt = this.jsFilesToEncrypt = [],
		htmlJsFiles = this.htmlJsFiles = {},
		symlinkFiles = this.target === 'simulator' && this.config.get('ios.symlinkResources', true) && !this.forceCopy && !this.forceCopyAll,
		_t = this;

	function copyDir(opts, callback) {
		if (opts && opts.src && fs.existsSync(opts.src) && opts.dest) {
			opts.origSrc = opts.src;
			opts.origDest = opts.dest;
			recursivelyCopy.call(this, opts.src, opts.dest, opts.ignoreRootDirs, opts, callback);
		} else {
			callback();
		}
	}

	function copyFile(from, to, next) {
		var d = path.dirname(to);
		fs.existsSync(d) || wrench.mkdirSyncRecursive(d);
		if (symlinkFiles && !unsymlinkableFileRegExp.test(path.basename(to))) {
			fs.existsSync(to) && fs.unlinkSync(to);
			this.logger.debug(__('Symlinking %s => %s', from.cyan, to.cyan));
			if (next) {
				fs.symlink(from, to, next);
			} else {
				fs.symlinkSync(from, to);
			}
		} else {
			this.logger.debug(__('Copying %s => %s', from.cyan, to.cyan));
			if (next) {
				fs.readFile(from, function (err, data) {
					if (err) throw err;
					fs.writeFile(to, data, next);
				});
			} else {
				fs.writeFileSync(to, fs.readFileSync(from));
			}
		}
	}

	function recursivelyCopy(src, dest, ignoreRootDirs, opts, done) {
		var files;
		if (fs.statSync(src).isDirectory()) {
			files = fs.readdirSync(src);
		} else {
			// we have a file, so fake a directory listing
			files = [ path.basename(src) ];
			src = path.dirname(src);
		}

		async.whilst(
			function () {
				return files.length;
			},

			function (next) {
				var filename = files.shift(),
					from = path.join(src, filename),
					to = path.join(dest, filename);

				// check that the file actually exists and isn't a broken symlink
				if (!fs.existsSync(from)) return next();

				var isDir = fs.statSync(from).isDirectory();

				// check if we are ignoring this file
				if ((isDir && ignoreRootDirs && ignoreRootDirs.indexOf(filename) !== -1) || (isDir ? ignoreDirs : ignoreFiles).test(filename)) {
					_t.logger.debug(__('Ignoring %s', from.cyan));
					return next();
				}

				// if this is a directory, recurse
				if (isDir) return recursivelyCopy.call(_t, from, path.join(dest, filename), null, opts, next);

				// we have a file, now we need to see what sort of file

				// if the destination directory does not exists, create it
				fs.existsSync(dest) || wrench.mkdirSyncRecursive(dest);

				var ext = filename.match(extRegExp),
					relPath = to.replace(opts.origDest, '').replace(/^\//, '');

				switch (ext && ext[1]) {
					case 'css':
						// if we encounter a css file, check if we should minify it
						if (_t.minifyCSS) {
							_t.logger.debug(__('Copying and minifying %s => %s', from.cyan, to.cyan));
							fs.readFile(from, function (err, data) {
								if (err) throw err;
								fs.writeFile(to, cleanCSS.process(data.toString()), next);
							});
						} else {
							copyFile.call(_t, from, to, next);
						}
						break;

					case 'html':
						// find all js files referenced in this html file
						var relPath = from.replace(opts.origSrc, '').replace(/\\/g, '/').replace(/^\//, '').split('/');
						relPath.pop(); // remove the filename
						relPath = relPath.join('/');
						jsanalyze.analyzeHtmlFile(from, relPath).forEach(function (file) {
							htmlJsFiles[file] = 1;
						});

						_t.cli.createHook('build.ios.copyResource', _t, function (from, to, cb) {
							copyFile.call(_t, from, to, cb);
						})(from, to, next);
						break;

					case 'js':
						// track each js file so we can copy/minify later

						// we use the destination file name minus the path to the assets dir as the id
						// which will eliminate dupes
						var id = to.replace(opts.origDest, '').replace(/^\//, '');
						if (!jsFiles[relPath] || !opts || !opts.onJsConflict || opts.onJsConflict(from, to, relPath)) {
							jsFiles[relPath] = from;
						}

						next();
						break;

					case 'jss':
						// ignore, these will be compiled later by compileJSS()
						next();
						break;

					default:
						// if the device family is iphone, then don't copy iPad specific images
						if (_t.deviceFamily !== 'iphone' || _t.ipadSplashImages.indexOf(relPath) === -1) {
							// normal file, just copy it into the build/iphone/bin/assets directory
							_t.cli.createHook('build.ios.copyResource', _t, function (from, to, cb) {
								copyFile.call(_t, from, to, cb);
							})(from, to, next);
						} else {
							next();
						}
				}
			},

			done
		);
	}

	var tasks = [
		// first task is to copy all files in the Resources directory, but ignore
		// any directory that is the name of a known platform
		function (cb) {
			copyDir.call(this, {
				src: path.join(this.projectDir, 'Resources'),
				dest: this.xcodeAppDir,
				ignoreRootDirs: ti.availablePlatformsNames
			}, cb);
		},

		// next copy all files from the iOS specific Resources directory
		function (cb) {
			copyDir.call(this, {
				src: path.join(this.projectDir, 'Resources', 'iphone'),
				dest: this.xcodeAppDir
			}, cb);
		},

		function (cb) {
			copyDir.call(this, {
				src: path.join(this.projectDir, 'Resources', 'ios'),
				dest: this.xcodeAppDir
			}, cb);
		}
	];

	// copy all commonjs modules
	this.commonJsModules.forEach(function (module) {
		// copy the main module
		tasks.push(function (cb) {
			copyDir.call(this, {
				src: module.libFile,
				dest: this.xcodeAppDir,
				onJsConflict: function (src, dest, id) {
					this.logger.error(__('There is a project resource "%s" that conflicts with a CommonJS module', id));
					this.logger.error(__('Please rename the file, then rebuild') + '\n');
					process.exit(1);
				}.bind(this)
			}, cb);
		});
	});

	// copy all module assets
	this.modules.forEach(function (module) {
		// copy the assets
		tasks.push(function (cb) {
			copyDir.call(this, {
				src: path.join(module.modulePath, 'assets'),
				dest: path.join(this.xcodeAppDir, 'modules', module.id.toLowerCase())
			}, cb);
		});
	});

	var platformPaths = [
		path.join(this.projectDir, this.cli.argv['platform-dir'] || 'platform', 'iphone'),
		path.join(this.projectDir, this.cli.argv['platform-dir'] || 'platform', 'ios')
	];
	// WARNING! This is pretty dangerous, but yes, we're intentionally copying
	// every file from platform/iphone|ios and all modules into the build dir
	this.modules.forEach(function (module) {
		platformPaths.push(
			path.join(module.modulePath, 'platform', 'iphone'),
			path.join(module.modulePath, 'platform', 'ios')
		);
	});
	platformPaths.forEach(function (dir) {
		if (fs.existsSync(dir)) {
			tasks.push(function (cb) {
				copyDir.call(this, {
					src: dir,
					dest: this.xcodeAppDir
				}, cb);
			});
		}
	}, this);

	series(this, tasks, function (err, results) {
		// copy js files into assets directory and minify if needed
		this.logger.info(__('Processing JavaScript files'));

		series(this, Object.keys(jsFiles).map(function (id) {
			return function (done) {
				var from = jsFiles[id],
					to = path.join(this.xcodeAppDir, id);

				if (htmlJsFiles[id]) {
					// this js file is referenced from an html file, so don't minify or encrypt
					return copyFile.call(this, from, to, done);
				}

				// we have a js file that may be minified or encrypted
				id = id.replace(/\./g, '_');

				// if we're encrypting the JavaScript, copy the files to the assets dir
				// for processing later
				if (this.encryptJS) {
					to = path.join(this.buildAssetsDir, id);
					jsFilesToEncrypt.push(id);
				}

				try {
					this.cli.createHook('build.ios.copyResource', this, function (from, to, cb) {
						// parse the AST
						var r = jsanalyze.analyzeJsFile(from, { minify: this.minifyJS });

						// we want to sort by the "to" filename so that we correctly handle file overwriting
						this.tiSymbols[to] = r.symbols;

						var dir = path.dirname(to);
						fs.existsSync(dir) || wrench.mkdirSyncRecursive(dir);

						if (this.minifyJS) {
							this.logger.debug(__('Copying and minifying %s => %s', from.cyan, to.cyan));

							this.cli.createHook('build.ios.compileJsFile', this, function (r, from, to, cb2) {
								fs.writeFile(to, r.contents, cb2);
							})(r, from, to, cb);
						} else if (symlinkFiles) {
							copyFile.call(this, from, to, cb);
						} else {
							// we've already read in the file, so just write the original contents
							this.logger.debug(__('Copying %s => %s', from.cyan, to.cyan));
							fs.writeFile(to, r.contents, cb);
						}
					})(from, to, done);
				} catch (ex) {
					ex.message.split('\n').forEach(this.logger.error);
					this.logger.log();
					process.exit(1);
				}
			};
		}), function () {
			// write the properties file
			var appPropsFile = this.encryptJS ? path.join(this.buildAssetsDir, '_app_props__json') : path.join(this.xcodeAppDir, '_app_props_.json'),
				props = {};
			this.tiapp.properties && Object.keys(this.tiapp.properties).forEach(function (prop) {
				props[prop] = this.tiapp.properties[prop].value;
			}, this);
			fs.writeFileSync(
				appPropsFile,
				JSON.stringify(props)
			);
			this.encryptJS && jsFilesToEncrypt.push('_app_props__json');

			if (!jsFilesToEncrypt.length) {
				// nothing to encrypt, continue
				return finished();
			}

			this.cli.fireHook('build.ios.prerouting', this, function (err) {
				var titaniumPrepHook = this.cli.createHook('build.ios.titaniumprep', this, function (exe, args, opts, done) {
						var tries = 0,
							completed = false;

						this.logger.info('Encrypting JavaScript files: %s', (exe + ' "' + args.join('" "') + '"').cyan);
						jsFilesToEncrypt.forEach(function (file) {
							this.logger.debug(__('Preparing %s', file.cyan));
						}, this);

						async.whilst(
							function () {
								if (tries > 3) {
									// we failed 3 times, so just give up
									this.logger.error(__('titanium_prep failed to complete successfully'));
									this.logger.error(__('Try cleaning this project and build again') + '\n');
									process.exit(1);
								}
								return !completed;
							},
							function (cb) {
								var child = spawn(exe, args, opts),
									out = '';

								child.stdin.write(jsFilesToEncrypt.join('\n'));
								child.stdin.end();

								child.stdout.on('data', function (data) {
									out += data.toString();
								});

								child.on('close', function (code) {
									if (code) {
										this.logger.error(__('titanium_prep failed to run (%s)', code) + '\n');
										process.exit(1);
									}

									if (out.indexOf('initWithObjectsAndKeys') !== -1) {
										// success!
										var file = path.join(this.buildDir, 'Classes', 'ApplicationRouting.m');
										this.logger.debug(__('Writing application routing source file: %s', file.cyan));
										fs.writeFileSync(
											file,
											ejs.render(fs.readFileSync(path.join(this.templatesDir, 'ApplicationRouting.m')).toString(), {
												bytes: out
											})
										);
										completed = true;
									} else {
										// failure, maybe it was a fluke, try again
										this.logger.warn(__('titanium_prep failed to complete successfully, trying again'));
										tries++;
									}

									cb();
								}.bind(this));
							}.bind(this),
							done
						);
					});

				titaniumPrepHook(
					path.join(this.platformPath, 'titanium_prep'),
					[ this.tiapp.id, this.buildAssetsDir, this.tiapp.guid ],
					{},
					finished
				);
			}.bind(this));
		});
	});
};

iOSBuilder.prototype.processTiSymbols = function processTiSymbols(finished) {
	var namespaces = {
			'analytics': 1,
			'api': 1,
			'network': 1,
			'platform': 1,
			'ui': 1
		},
		symbols = {};

	// generate the default symbols
	Object.keys(namespaces).forEach(function (ns) {
		symbols[ns.toUpperCase()] = 1;
	});

	function addSymbol(symbol) {
		var parts = symbol.replace(/^(Ti|Titanium)./, '').split('.');
		if (parts.length) {
			namespaces[parts[0].toLowerCase()] = 1;
			while (parts.length) {
				symbols[parts.join('.').replace(/\.create/gi, '').replace(/\./g, '').replace(/\-/g, '_').toUpperCase()] = 1;
				parts.pop();
			}
		}
	}

	// add the symbols we found
	Object.keys(this.tiSymbols).forEach(function (file) {
		this.tiSymbols[file].forEach(addSymbol);
	}, this);

	// for each module, if it has a metadata.json file, add its symbols
	this.modules.forEach(function (m) {
		var file = path.join(m.modulePath, 'metadata.json');
		if (fs.existsSync(file)) {
			try {
				var metadata = JSON.parse(fs.readFileSync(file));
				if (metadata && typeof metadata === 'object' && Array.isArray(metadata.exports)) {
					metadata.exports.forEach(addSymbol);
				}
			} catch (e) {}
		}
	});

	// for each Titanium namespace, copy any resources
	this.logger.info(__('Processing Titanium namespace resources'));
	Object.keys(namespaces).forEach(function (ns) {
		var src = path.join(this.platformPath, 'modules', ns, 'images');
		if (fs.existsSync(src)) {
			this.copyDirSync(src, path.join(this.xcodeAppDir, 'modules', ns, 'images'));
		}
	}, this);

	var dest = path.join(this.buildDir, 'Classes', 'defines.h');

	// if we're doing a simulator build or we're including all titanium modules,
	// return now since we don't care about writing the defines.h
	if (this.target === 'simulator' || this.includeAllTiModules) {
		// BEGIN TIMOB-17892 changes
		if (this.useJSCore) {
			this.logger.debug(__('Using JavaScriptCore Framework'));
			fs.writeFileSync(
				dest,
				fs.readFileSync(path.join(this.platformPath, 'Classes', 'defines.h')).toString() + '\n#define USE_JSCORE_FRAMEWORK'
			);
		} 
		// END TIMOB-17892 changes
		return finished();
	}

	// build the defines.h file
	var contents = [
			'// Warning: this is generated file. Do not modify!',
			'',
			'#define TI_VERSION ' + this.titaniumSdkVersion
		];

	contents = contents.concat(Object.keys(symbols).sort().map(function (s) {
		return '#define USE_TI_' + s;
	}));

	var infoPlist = this.infoPlist;
	if (!infoPlist) {
		infoPlist = new appc.plist(this.buildDir + '/Info.plist');
	}

	if (Array.isArray(infoPlist.UIBackgroundModes) && infoPlist.UIBackgroundModes.indexOf('remote-notification') !== -1) {
		contents.push('#define USE_TI_SILENTPUSH');
	}
	if (Array.isArray(infoPlist.UIBackgroundModes) && infoPlist.UIBackgroundModes.indexOf('fetch') !== -1) {
		contents.push('#define USE_TI_FETCH');
	}

	contents.push(
		'#ifdef USE_TI_UILISTVIEW',
		'#define USE_TI_UILABEL',
		'#define USE_TI_UIBUTTON',
		'#define USE_TI_UIIMAGEVIEW',
		'#define USE_TI_UIPROGRESSBAR',
		'#define USE_TI_UIACTIVITYINDICATOR',
		'#define USE_TI_UISWITCH',
		'#define USE_TI_UISLIDER',
		'#define USE_TI_UITEXTFIELD',
		'#define USE_TI_UITEXTAREA',
		'#endif'
	);
	// BEGIN TIMOB-17892 changes
	if (this.useJSCore) {
		this.logger.debug(__('Using JavaScriptCore Framework'));
		contents.push('#define USE_JSCORE_FRAMEWORK')
	}
	// END TIMOB-17892 changes

	contents = contents.join('\n');

	if (!fs.existsSync(dest) || fs.readFileSync(dest).toString() !== contents) {
		this.logger.debug(__('Writing Titanium symbol file: %s', dest.cyan));
		fs.writeFileSync(dest, contents);
	} else {
		this.logger.debug(__('Titanium symbol file already up-to-date: %s', dest.cyan));
	}

	finished();
};

iOSBuilder.prototype.optimizeImages = function optimizeImages(next) {
	// if we're doing a simulator build, return now since we don't care about optimizing images
	if (this.target === 'simulator') {
		return next();
	}

	var tool = path.join(this.xcodeEnv.path, 'Platforms', 'iPhoneOS.platform', 'Developer', 'usr', 'bin', 'iphoneos-optimize');
	if (fs.existsSync(tool)) {
		this.logger.info(__('Optimizing all images in %s', this.xcodeAppDir.cyan));
		appc.subprocess.run(tool, this.xcodeAppDir, function (code, out, err) {
			// remove empty directories
			this.logger.debug(__('Removing empty directories'));
			appc.subprocess.run('find', ['.', '-type', 'd', '-empty', '-delete'], {
				cwd: this.xcodeAppDir
			}, function (code, out, err) {
				this.logger.info(__('Image optimization complete'));
				appc.fs.touch(this.imagesOptimizedFile);
				next();
			}.bind(this));
		}.bind(this));
	} else {
		this.logger.warn(__('Unable to find iphoneos-optimize, skipping image optimization'));
		appc.fs.touch(this.imagesOptimizedFile);
		next();
	}
};

// create the builder instance and expose the public api
(function (iosBuilder) {
	exports.config   = iosBuilder.config.bind(iosBuilder);
	exports.validate = iosBuilder.validate.bind(iosBuilder);
	exports.run      = iosBuilder.run.bind(iosBuilder);
}(new iOSBuilder(module)));

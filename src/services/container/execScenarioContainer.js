const fs = require('node:fs');
const util = require('node:util');
const path = require('node:path');
const { parse } = require('envfile');
const exec = util.promisify(require('node:child_process').exec);
const { CONTAINER_DEVICE_NAME } = require('../../constants');
const ScenarioError = require('../errors/ScenarioError');
const initDebug = require('debug');

const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const debug = initDebug('greenframe:services:container:execScenarioContainer');

const readFile = util.promisify(fs.readFile);

const createContainer = async (
    extraHosts = [],
    customEnvVars = [],
    customEnvVarsFile = ''
) => {
    const { stdout } = await exec(`${PROJECT_ROOT}/dist/bash/getHostIP.sh`);
    const HOSTIP = stdout;
    const extraHostsFlags = extraHosts
        .map((extraHost) => ` --add-host ${extraHost}:${HOSTIP}`)
        .join('');

    const extraHostsEnv =
        extraHosts.length > 0 ? ` -e EXTRA_HOSTS=${extraHosts.join(',')}` : '';

    const envVars =
        customEnvVars.length > 0
            ? await buildEnvVarList(customEnvVars, customEnvVarsFile)
            : '';

    debug(`Creating container ${CONTAINER_DEVICE_NAME} with extraHosts: ${extraHosts}`);

    const dockerCleanPreviousCommand = `docker rm -f ${CONTAINER_DEVICE_NAME}`;
    const allEnvVars = ` -e HOSTIP=${HOSTIP}${extraHostsEnv}${envVars}`;
    const dockerCreateCommand = `docker create --tty --name ${CONTAINER_DEVICE_NAME} --rm ${allEnvVars} --add-host localhost:${HOSTIP} ${extraHostsFlags} mcr.microsoft.com/playwright:v1.30.0-focal`;

    const dockerStatCommand = `${dockerCleanPreviousCommand} && ${dockerCreateCommand}`;
    debug(`Docker command ${dockerStatCommand}`);
    await exec(dockerStatCommand);

    debug(`Container ${CONTAINER_DEVICE_NAME} created`);

    debug(`Copying greenframe files to container ${CONTAINER_DEVICE_NAME}`);
    // For some reason, mounting the volume when you're doing docker in docker doesn't work, but the copy command does.
    const dockerCopyCommand = `docker cp ${PROJECT_ROOT} ${CONTAINER_DEVICE_NAME}:/greenframe`;
    await exec(dockerCopyCommand);
    debug(`Files copied to container ${CONTAINER_DEVICE_NAME}`);
};

const startContainer = async () => {
    const { stderr } = await exec(`docker start ${CONTAINER_DEVICE_NAME}`);
    if (stderr) {
        throw new Error(stderr);
    }

    return 'OK';
};

const execScenarioContainer = async (
    scenario,
    url,
    { useAdblock, ignoreHTTPSErrors, locale, timezoneId } = {}
) => {
    try {
        let command = `docker exec ${CONTAINER_DEVICE_NAME} node /greenframe/dist/runner/index.js --scenario="${encodeURIComponent(
            scenario
        )}" --url="${encodeURIComponent(url)}"`;

        if (useAdblock) {
            command += ` --useAdblock`;
        }

        if (ignoreHTTPSErrors) {
            command += ` --ignoreHTTPSErrors`;
        }

        if (locale) {
            command += ` --locale=${locale}`;
        }

        if (timezoneId) {
            command += ` --timezoneId=${timezoneId}`;
        }

        const { stdout, stderr } = await exec(command);

        if (stderr) {
            throw new Error(stderr);
        }

        const timelines = JSON.parse(stdout.split('=====TIMELINES=====')[1]);
        const milestones = JSON.parse(stdout.split('=====MILESTONES=====')[1] || '[]');

        return { timelines, milestones };
    } catch (error) {
        throw new ScenarioError(error.stderr || error.message);
    }
};

const stopContainer = async () => {
    try {
        // The container might take a while to stop.
        // We rename it to avoid conflicts when recreating it (if it is still removing while we try to create it again, it will fail).
        await exec(
            `docker rename ${CONTAINER_DEVICE_NAME} ${CONTAINER_DEVICE_NAME}-stopping && docker stop ${CONTAINER_DEVICE_NAME}-stopping`
        );
    } catch {
        // Avoid Throwing error.
        // If container is not running this command throw an error.
        return false;
    }

    return 'OK';
};

const buildEnvVarList = async (customEnvVars, customEnvVarsFile) => {
    const fileEnvVars = await parseEnvFile(customEnvVarsFile);
    let uniqueEnvVars = [...new Set(customEnvVars.concat(fileEnvVars))];
    return uniqueEnvVars.reduce((list, envVarName) => {
        const envVarValue = process.env[envVarName];
        return `${list} -e ${envVarName}=${envVarValue} `;
    }, '');
};

const parseEnvFile = async (path) => {
    try {
        const file = await readFile(path, 'utf8');
        if (file) {
            const vars = parse(file);

            return Object.keys(vars);
        }
    } catch {
        // Do Nothing
    }
};

module.exports = {
    createContainer,
    startContainer,
    execScenarioContainer,
    stopContainer,
};

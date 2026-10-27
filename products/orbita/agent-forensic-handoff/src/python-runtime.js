// Each override is one executable path. Never parse it as a shell command.
export function pythonExecutable(overrides = [], {env = process.env, platform = process.platform} = {}) {
  for (const name of [...overrides, 'AFH_PYTHON']) {
    const value = env[name];
    if (value == null || value === '') continue;
    if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) {
      const error = new Error(name + ' must name one Python executable');
      error.code = 'PYTHON_EXECUTABLE_INVALID';
      throw error;
    }
    return value;
  }
  return platform === 'win32' ? 'python' : 'python3';
}

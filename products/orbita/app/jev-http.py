"""Private Windows credential boundary. Only validated provider JSON leaves stdout.

One request, pinned endpoint, no proxies, redirects, retries or secret logging.
This worker deliberately reads HKCU itself; no secret crosses the Node/UI boundary.
"""
import json, math, sys, urllib.request, urllib.error

ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
MODEL = 'jev-1.14.0'
MAX_WIRE = 60000
MAX_RESPONSE = 500000

class BoundaryError(Exception):
    pass

def require(ok, code):
    if not ok: raise BoundaryError(code)

def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'JEV_RESPONSE_SCHEMA')
        result[key] = value
    return result

def decode(raw):
    try:
        return json.loads(raw.decode('utf8'), object_pairs_hook=unique_pairs,
                          parse_constant=lambda x: (_ for _ in ()).throw(ValueError()))
    except Exception:
        raise BoundaryError('JEV_RESPONSE_SCHEMA') from None

def credential(name):
    require(name in ('TYPESAFE_API_KEY', 'JEV_Vercel'), 'JEV_CREDENTIAL_REFERENCE')
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as key:
            value, kind = winreg.QueryValueEx(key, name)
        require(kind == winreg.REG_SZ and type(value) is str and 8 <= len(value) <= 4096
                and value.isascii() and not any(c.isspace() for c in value), 'JEV_CREDENTIAL_UNAVAILABLE')
        return value
    except Exception:
        raise BoundaryError('JEV_CREDENTIAL_UNAVAILABLE') from None

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise BoundaryError('JEV_REDIRECT_REJECTED')

def probability(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1

def validate_response(value, body):
    require(type(value) is dict and set(value) == {'model', 'answers', 'usage'}, 'JEV_RESPONSE_SCHEMA')
    require(value['model'] == MODEL, 'JEV_MODEL_MISMATCH')
    usage, answers = value['usage'], value['answers']
    require(type(usage) is dict and set(usage) == {'input_tokens', 'output_tokens'}
            and all(type(usage[k]) is int and 0 <= usage[k] <= 65536 for k in usage), 'JEV_USAGE_INVALID')
    require(type(answers) is dict and set(answers) == set(body['questions']), 'JEV_RESPONSE_SCHEMA')
    for key, question in body['questions'].items():
        answer = answers[key]
        require(type(answer) is dict and answer.get('type') == question['type'], 'JEV_RESPONSE_SCHEMA')
        if question['type'] == 'noul':
            require(set(answer) == {'type','noul'} and probability(answer['noul']), 'JEV_RESPONSE_SCHEMA')
        else:
            require(set(answer) == {'type','choice','confidence','probabilities'}, 'JEV_RESPONSE_SCHEMA')
            probs = answer['probabilities']
            require(type(probs) is dict and set(probs) == set(question['criteria'])
                    and all(probability(p) for p in probs.values())
                    and abs(sum(probs.values()) - 1) <= 1e-6, 'JEV_RESPONSE_SCHEMA')
            require(answer['choice'] in probs and probs[answer['choice']] >= max(probs.values()) - 1e-9
                    and probability(answer['confidence']), 'JEV_RESPONSE_SCHEMA')
    return value

def send(body, name, timeout):
    require(type(body) is dict and set(body) == {'model','state','questions'} and body['model'] == MODEL,
            'JEV_REQUEST_INVALID')
    wire = json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf8')
    require(len(wire) <= MAX_WIRE and type(timeout) in (int,float) and 0 < timeout <= 25, 'JEV_REQUEST_INVALID')
    token = credential(name)
    request = urllib.request.Request(ENDPOINT, data=wire, method='POST',
        headers={'Authorization':'Bearer '+token, 'Content-Type':'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            require(response.geturl() == ENDPOINT and response.status == 200, 'JEV_HTTP_REJECTED')
            raw = response.read(MAX_RESPONSE + 1)
            require(len(raw) <= MAX_RESPONSE, 'JEV_RESPONSE_TOO_LARGE')
            return validate_response(decode(raw), body)
    except urllib.error.HTTPError as error:
        # Never return an error body, header or dependency exception string.
        raise BoundaryError('JEV_HTTP_' + str(error.code)) from None
    finally:
        token = None

def main():
    try:
        raw = sys.stdin.buffer.read(MAX_WIRE + 2048)
        require(len(raw) < MAX_WIRE + 2048, 'JEV_REQUEST_INVALID')
        request = decode(raw)
        value = send(request['body'], request['credentialReference'], request['timeoutSeconds'])
        print(json.dumps({'ok':True,'value':value}, ensure_ascii=False))
    except BoundaryError as error:
        # BoundaryError is created only with local literal codes / numeric HTTP status.
        print(json.dumps({'ok':False,'code':str(error)}))
    except Exception:
        print(json.dumps({'ok':False,'code':'JEV_TRANSPORT_UNCERTAIN'}))

if __name__ == '__main__': main()

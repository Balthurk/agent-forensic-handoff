import importlib.util, pathlib, unittest, json, io, contextlib
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('jev_http',pathlib.Path(__file__).with_name('jev-http.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
BODY={'model':m.MODEL,'state':{'question':'Test'},'questions':{'member':{'type':'noul','instructions':'Test'}}}
GOOD={'model':m.MODEL,'answers':{'member':{'type':'noul','noul':.9}},'usage':{'input_tokens':10,'output_tokens':1}}
class Tests(unittest.TestCase):
 def test_duplicate_json_rejected(self):
  with self.assertRaises(m.BoundaryError): m.decode(b'{"model":"x","model":"y"}')
 def test_untrusted_exceptions_are_redacted(self):
  data=json.dumps({'body':BODY,'credentialReference':'TYPESAFE_API_KEY','timeoutSeconds':2}).encode()
  out=io.StringIO()
  with patch.object(m.sys,'stdin',io.TextIOWrapper(io.BytesIO(data))),patch.object(m,'send',side_effect=RuntimeError('secret-value')),contextlib.redirect_stdout(out): m.main()
  self.assertEqual(json.loads(out.getvalue()),{'ok':False,'code':'JEV_TRANSPORT_UNCERTAIN'})
 def test_redirects_rejected(self):
  with self.assertRaisesRegex(m.BoundaryError,'REDIRECT'): m.NoRedirect().redirect_request(None,None,302,'',{},'https://other.invalid')
 def test_exact_endpoint_and_header_stay_inside_worker(self):
  class Response:
   status=200
   def geturl(self): return m.ENDPOINT
   def read(self,n): return json.dumps(GOOD).encode()
   def __enter__(self): return self
   def __exit__(self,*a): pass
  class Opener:
   def open(self,request,timeout):
    self_request.assertEqual(request.full_url,m.ENDPOINT);self_request.assertEqual(request.get_header('Authorization'),'Bearer secret-private');return Response()
  self_request=self
  with patch.object(m,'credential',return_value='secret-private'),patch.object(m.urllib.request,'build_opener',return_value=Opener()): result=m.send(BODY,'TYPESAFE_API_KEY',2)
  self.assertEqual(result,GOOD);self.assertNotIn('secret-private',json.dumps(result))
 def test_response_cannot_smuggle_secret_in_extra_fields(self):
  for value in [{**GOOD,'extra':'secret-private'},{**GOOD,'model':'secret-private'},{**GOOD,'answers':{'member':{'type':'noul','noul':.9,'secret':'private'}}}]:
   with self.assertRaises(m.BoundaryError): m.validate_response(value,BODY)
 def test_credential_lookup_rejects_arbitrary_names(self):
  with self.assertRaisesRegex(m.BoundaryError,'CREDENTIAL_REFERENCE'): m.credential('UNRELATED_SECRET')
if __name__=='__main__': unittest.main()

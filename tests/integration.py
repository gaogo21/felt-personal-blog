#!/usr/bin/env python3
"""Real PostgreSQL + HTTP acceptance tests; never uses the normal content database."""
import concurrent.futures, copy, hashlib, http.cookiejar, json, os, pathlib, secrets, socket, subprocess, tempfile, time, unittest, urllib.error, urllib.request, uuid
ROOT = pathlib.Path(__file__).resolve().parents[1]
DOTNET = os.environ.get('DOTNET', 'dotnet')
base_env = os.environ.copy()
connection = base_env.get('ConnectionStrings__Blog', '')
if not connection: raise SystemExit('Set ConnectionStrings__Blog (test creates isolated felt_test_* databases).')
parts = dict(p.split('=',1) for p in connection.split(';') if p)
prefix = uuid.uuid4().hex[:12]
database = 'felt_test_'+prefix
parts['Database'] = database
password = secrets.token_urlsafe(24)
with socket.socket() as s: s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
BASE = f'http://127.0.0.1:{port}'
(ROOT/'runtime').mkdir(exist_ok=True)
TEMP = tempfile.TemporaryDirectory(prefix='felt-acceptance-', dir=ROOT/'runtime')
storage = pathlib.Path(TEMP.name)/'private'
env = {**base_env, 'ASPNETCORE_ENVIRONMENT':'Development','ASPNETCORE_URLS':BASE,'Blog__StoragePath':str(storage),
       'Blog__AdminName':'acceptance','Blog__AdminPassword':password,'ConnectionStrings__Blog':';'.join(k+'='+v for k,v in parts.items())}
command = [DOTNET, 'run', '--project', str(ROOT/'src/Blog.Web'), '--no-build', '--']

def cli(args, success=True):
    p = subprocess.run(command+args, env=env, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if (p.returncode==0) != success: raise AssertionError('CLI failed: '+p.stdout.decode()[-4000:])
    return p

def sql(query, db='postgres'):
    container = os.environ.get('TEST_DB_CONTAINER')
    if container: args=['docker','exec',container,'psql','-U',parts.get('Username','felt'),'-d',db,'-tAc',query]; e=env
    else:
        args=['psql','-tAc',query]
        e={**env,'PGHOST':parts.get('Host','127.0.0.1'),'PGPORT':parts.get('Port','5432'),'PGUSER':parts.get('Username','felt'),'PGPASSWORD':parts.get('Password',''),'PGDATABASE':db}
    return subprocess.check_output(args,env=e).decode().strip()

def clone_jar(jar):
    result=http.cookiejar.CookieJar()
    for cookie in jar: result.set_cookie(copy.copy(cookie))
    return result

class Client:
    def __init__(self):
        self.jar=http.cookiejar.CookieJar(); self.open=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar)); self.csrf=None
    def request(self,path,method='GET',body=None,etag=None,key=None,expected=200,headers=None,raw=None):
        url=BASE+path if path.startswith('/') else path
        h={'Accept':'application/json',**(headers or {})}
        if method!='GET':
            if self.csrf: h['X-CSRF-TOKEN']=self.csrf
            h.setdefault('Origin',BASE)
        if etag: h['If-Match']=etag
        if key: h['Idempotency-Key']=str(key)
        if body is not None: h['Content-Type']='application/json';raw=json.dumps(body,ensure_ascii=False).encode()
        try:r=self.open.open(urllib.request.Request(url,data=raw,headers=h,method=method),timeout=120)
        except urllib.error.HTTPError as e:r=e
        data=r.read()
        try: value=json.loads(data) if data else None
        except (ValueError,UnicodeDecodeError):value=data
        if r.code!=expected:raise AssertionError(f'{method} {path}: wanted {expected}, got {r.code}: {str(value)[:1500]}')
        return value,dict(r.headers)
    def get(self,path):return self.request('/api/admin/v1'+path)[0]
    def public(self,path,expected=200):return self.request('/api/public/v1'+path,expected=expected)[0]
    def change(self,path,body=None,method='POST',etag=None,key=True,expected=200,headers=None):return self.request('/api/admin/v1'+path,method,body,etag,uuid.uuid4() if key is True else key,expected,headers)[0]
    def login(self):
        self.csrf=self.get('/session/bootstrap')['csrfToken']
        result=self.change('/session',{'userName':'acceptance','password':password},key=False)
        self.csrf=result['csrfToken']
    def upload(self,name,data,mime,expected=202):
        boundary='felt'+uuid.uuid4().hex
        raw=(f'--{boundary}\r\nContent-Disposition: form-data; name="sha256"\r\n\r\n{hashlib.sha256(data).hexdigest()}\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n').encode()+data+f'\r\n--{boundary}--\r\n'.encode()
        return self.request('/api/admin/v1/media/uploads','POST',key=uuid.uuid4(),expected=expected,raw=raw,headers={'Content-Type':'multipart/form-data; boundary='+boundary})[0]
    def wait_media(self,id,state='Ready'):
        end=time.monotonic()+90
        while time.monotonic()<end:
            a=self.get('/media/'+id)
            if a['state']==state:return a
            if a['state']=='Rejected' and state!='Rejected':raise AssertionError('Media processing failed: '+str(a))
            time.sleep(.25)
        raise AssertionError('Media timeout: '+str(a))

class Acceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.session=Client();cls.session.login()
    def setUp(self):
        if self._testMethodName == 'test_99_restart_reset_and_repeat_seed_preserve_content':
            self.session=Client();self.session.login()
        self.c=Client();self.c.jar=clone_jar(self.session.jar);self.c.open=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.c.jar));self.c.csrf=self.session.csrf
        self.columns=self.c.get('/columns')['items'];self.cover=self.columns[0]['imageIds'][0]
    def create(self,kind='Article'):
        return self.c.change('/articles',{'title':'验收草稿','slug':'acceptance-'+uuid.uuid4().hex[:12],'kind':kind},expected=201)
    def draft(self,a,title='已保存正文',content=None):
        return {'title':title,'summary':'摘要','intro':'导语','columnId':self.columns[0]['id'],'coverMediaId':self.cover,'schemaVersion':1,
                'contentJson':content or {'type':'doc','content':[{'type':'heading','attrs':{'level':2,'id':str(uuid.uuid4())},'content':[{'type':'text','text':'目录锚点'}]},{'type':'paragraph','content':[{'type':'text','text':'实际业务验收 <script>alert(1)</script>'}]}]}}
    def save(self,a,title='已保存正文',content=None):
        d=self.c.change('/articles/'+a['id']+'/draft',self.draft(a,title,content),'PUT',a['draft']['etag'],False)
        a=copy.deepcopy(a);a['draft']=d;return a
    def publish(self,a):
        return self.c.change('/articles/'+a['id']+'/publish',{'draftEtag':a['draft']['etag']},etag=a['etag'])
    def test_01_authentication_csrf_and_origin(self):
        self.c=Client();self.c.login()
        anon=Client();anon.request('/api/admin/v1/articles',expected=401)
        c=Client();c.csrf=c.get('/session/bootstrap')['csrfToken'];c.change('/session',{'userName':'acceptance','password':'wrong'},key=False,expected=401)
        c=Client();c.request('/api/admin/v1/session','POST',body={'userName':'acceptance','password':password},expected=403)
        self.c.change('/articles',{'title':'x','slug':'bad-origin'},headers={'Origin':'https://evil.example'},expected=403)
        self.c.change('/session',method='DELETE',key=False,expected=204);self.c.request('/api/admin/v1/articles',expected=401)
    def test_02_seed_and_public_boundary(self):
        items=self.c.public('/articles')['items'];self.assertGreaterEqual(len(items),8)
        demo=[x for x in items if x['isDemo']];self.assertEqual(len(demo),8)
        detail=self.c.public('/articles/io-multiplexing');self.assertTrue(detail['toc'])
        for h in detail['toc']:self.assertIn('id="'+h['id']+'"',detail['bodyHtml'])
        text=json.dumps(self.c.public('/home'))+json.dumps(detail)
        for secret in ['passwordHash','securityStamp','storageKey','contentJson','leaseToken']:self.assertNotIn(secret,text)
        self.c.public('/articles?page=0',422);self.c.public('/columns/missing',404)
    def test_03_draft_publish_revision_and_lifecycle(self):
        a=self.create();self.c.public('/articles/'+a['slug'],404);a=self.save(a);a=self.publish(a)
        read=self.c.public('/articles/'+a['slug']);self.assertEqual(read['title'],'已保存正文');self.assertNotIn('<script>',read['bodyHtml']);self.assertIn('&lt;script&gt;',read['bodyHtml'])
        a=self.save(a,'尚未发布的修改');self.assertEqual(self.c.public('/articles/'+a['slug'])['title'],'已保存正文')
        a=self.publish(a);revisions=self.c.get('/articles/'+a['id']+'/revisions');self.assertEqual(len(revisions),2)
        old=min(revisions,key=lambda x:x['number'])
        d=self.c.change('/articles/'+a['id']+'/revisions/'+old['id']+'/restore',etag=a['draft']['etag']);a['draft']=d
        self.assertEqual(self.c.public('/articles/'+a['slug'])['title'],'尚未发布的修改')
        a=self.publish(a);self.assertEqual(self.c.public('/articles/'+a['slug'])['title'],'已保存正文')
        a=self.c.change('/articles/'+a['id']+'/withdraw',etag=a['etag']);self.c.public('/articles/'+a['slug'],404)
        a=self.c.change('/articles/'+a['id']+'/trash',etag=a['etag']);a=self.c.change('/articles/'+a['id']+'/restore',etag=a['etag']);self.assertEqual(a['state'],'Withdrawn');self.c.public('/articles/'+a['slug'],404)
    def test_04_etag_idempotency_purge(self):
        key=uuid.uuid4();body={'title':'唯一','slug':'key-'+uuid.uuid4().hex[:12],'kind':'Article'}
        a=self.c.change('/articles',body,key=key,expected=201);again=self.c.change('/articles',body,key=key,expected=201);self.assertEqual(a['id'],again['id'])
        self.c.change('/articles',{**body,'title':'另一个'},key=key,expected=409)
        self.c.change('/articles/'+a['id']+'/draft',self.draft(a),method='PUT',key=False,expected=428)
        stale=a['draft']['etag'];a=self.save(a);self.c.change('/articles/'+a['id']+'/draft',self.draft(a),method='PUT',etag=stale,key=False,expected=412)
        a=self.c.change('/articles/'+a['id']+'/trash',etag=a['etag'])
        self.c.change('/articles/'+a['id']+'/purge',{'confirmSlug':a['slug']},etag=a['etag'],expected=403)
        self.c.change('/session/reauth',{'password':password},key=False,expected=204)
        a=self.c.change('/articles/'+a['id']+'/purge',{'confirmSlug':a['slug']},etag=a['etag']);self.assertIsNone(a['draft'])
        self.c.change('/articles',body,key=key,expected=410)
        self.c.change('/articles',body,expected=409)
    def test_05_concurrent_draft_writers(self):
        a=self.create();body=self.draft(a)
        def save():
            c=Client();c.jar=clone_jar(self.session.jar);c.open=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(c.jar));c.csrf=self.session.csrf
            try:c.change('/articles/'+a['id']+'/draft',body,'PUT',a['draft']['etag'],False);return 200
            except AssertionError as e:
                if 'got 412:' in str(e):return 412
                raise
        with concurrent.futures.ThreadPoolExecutor(2) as pool:results=list(pool.map(lambda _:save(),range(2)))
        self.assertEqual(sorted(results),[200,412])
    def test_06_richtext_rejects_unknown_nodes_and_urls(self):
        a=self.create()
        for content in [{'type':'doc','content':[{'type':'script','content':[]}]},{'type':'doc','content':[{'type':'paragraph','content':[{'type':'text','text':'evil','marks':[{'type':'link','attrs':{'href':'javascript:alert(1)'}}]}]}]}]:
            self.c.change('/articles/'+a['id']+'/draft',self.draft(a,content=content),'PUT',a['draft']['etag'],False,422)
        self.assertEqual(self.c.get('/articles/'+a['id'])['draft']['version'],1)
    def test_07_columns_and_order(self):
        ids=[c['id'] for c in self.columns];site=self.c.get('/site')
        self.c.change('/columns/order',{'ids':list(reversed(ids))},'PUT',site['etag'],False)
        self.assertEqual([c['id'] for c in self.c.public('/columns')],list(reversed(ids)))
        body={'slug':'column-'+uuid.uuid4().hex[:8],'name':'测试专栏','introduction':'说明','imageIds':self.columns[0]['imageIds']}
        for images in [[],body['imageIds'][:2],body['imageIds']+[self.cover],[self.cover]*3]:
            rejected=self.c.change('/columns',{**body,'imageIds':images},expected=422)
            self.assertIn('imageIds',rejected['fields'])
        self.c.change('/columns',{**body,'introduction':'   '},expected=422)
        col=self.c.change('/columns',body,expected=201)
        col=self.c.change('/columns/'+col['id']+'/activate',etag=col['etag']);self.c.public('/columns/'+col['slug'])
        col=self.c.change('/columns/'+col['id']+'/archive',etag=col['etag']);self.c.public('/columns/'+col['slug'],404)
        col=next(x for x in self.c.get('/columns')['items'] if x['publishedArticleCount']>0)
        self.c.change('/columns/'+col['id']+'/archive',etag=col['etag'],expected=409)
        public=self.c.public('/columns/'+col['slug']);ids=[x['entityId'] for x in public['articles']]
        self.c.change('/columns/'+col['id']+'/articles/order',{'ids':list(reversed(ids))},'PUT',col['etag'],False)
        self.assertEqual([x['entityId'] for x in self.c.public('/columns/'+col['slug'])['articles']],list(reversed(ids)))
        extra=[]
        initial_count=len(self.c.public('/columns'))
        self.assertLessEqual(initial_count,6)
        for index in range(6-initial_count):
            item=self.c.change('/columns',{**body,'slug':'six-'+uuid.uuid4().hex[:8],'name':'新增专栏 '+str(index+1)},expected=201)
            extra.append(self.c.change('/columns/'+item['id']+'/activate',etag=item['etag']))
        visible=self.c.public('/columns');self.assertEqual(len(visible),6)
        self.assertTrue(all(len(item['images'])==3 for item in visible))
        for item in extra:self.c.change('/columns/'+item['id']+'/archive',etag=item['etag'])
    def test_08_project_publication_isolation(self):
        p=self.c.change('/projects',{'title':'项目验收','slug':'project-'+uuid.uuid4().hex[:8]},expected=201)
        draft={**p['draft'],'body':'真实过程','summary':'已发布摘要','coverMediaId':self.cover}
        p=self.c.change('/projects/'+p['id'],draft,'PUT',p['etag'],False);p=self.c.change('/projects/'+p['id']+'/publish',etag=p['etag'])
        self.assertEqual(self.c.public('/projects/'+p['slug'])['desc'],'已发布摘要')
        p=self.c.change('/projects/'+p['id'],{**draft,'summary':'未发布摘要'},'PUT',p['etag'],False)
        self.assertEqual(self.c.public('/projects/'+p['slug'])['desc'],'已发布摘要')
        p=self.c.change('/projects/'+p['id']+'/trash',etag=p['etag']);self.c.public('/projects/'+p['slug'],404)
        p=self.c.change('/projects/'+p['id']+'/restore',etag=p['etag']);self.assertFalse(p['published'])
    def test_09_site_knowledge_and_life(self):
        a=self.save(self.create('Life'),'发布随记');a=self.publish(a)
        chapter=self.c.change('/knowledge',{'title':'验收章节','articleIds':[a['id']]},expected=201)
        self.assertTrue(any(c['title']=='验收章节' for c in self.c.public('/knowledge')))
        self.assertIn(a['slug'],[i['slug'] for i in self.c.public('/articles?kind=Life')['items']])
        site=self.c.get('/site');baseline=copy.deepcopy(site['value'])
        for count in [0,2,4]:
            ids=baseline['featuredIds'][:count] if count<3 else baseline['featuredIds']+[a['id']]
            rejected=self.c.change('/site',{**baseline,'featuredIds':ids},'PUT',site['etag'],False,422)
            self.assertIn('featuredIds',rejected['fields'])
        for ids in [baseline['galleryIds'][:9],baseline['galleryIds']+[str(uuid.uuid4())],[baseline['galleryIds'][0]]*10]:
            rejected=self.c.change('/site',{**baseline,'galleryIds':ids},'PUT',site['etag'],False,422)
            self.assertIn('galleryIds',rejected['fields'])
        self.c.change('/site',{**baseline,'featuredIds':[a['id']]*3},'PUT',site['etag'],False,422)
        value={**baseline,'aboutTitle':'后端设置已生效','homeAbout':'First line\n第二行\n\nFourth line <script>literal</script>','featuredIds':[a['id']]+baseline['featuredIds'][:2],'galleryIds':list(reversed(baseline['galleryIds']))}
        self.c.change('/site',value,'PUT',site['etag'],False)
        self.assertEqual(self.c.public('/about')['title'],value['aboutTitle']);self.assertEqual(self.c.public('/home')['featured'][0]['slug'],a['slug'])
        home=self.c.public('/home');self.assertEqual(home['homeAbout'],value['homeAbout']);self.assertEqual(len(home['featured']),3)
        self.assertEqual([image['id'] for image in home['gallery']],value['galleryIds'])
        for action in ['withdraw','trash']:
            blocked=self.c.change('/articles/'+a['id']+'/'+action,etag=a['etag'],expected=409)
            self.assertEqual(blocked['code'],'ARTICLE_FEATURED')
        site=self.c.get('/site');self.c.change('/site',{**site['value'],'featuredIds':baseline['featuredIds']},'PUT',site['etag'],False)
        a=self.c.change('/articles/'+a['id']+'/withdraw',etag=a['etag']);self.assertFalse(any(c['title']=='验收章节' for c in self.c.public('/knowledge')))
        self.assertEqual(len(self.c.public('/home')['featured']),3)
        self.c.change('/knowledge/'+chapter['id'],method='DELETE',etag=chapter['etag'],key=False)
    def test_10_native_image_pipeline_and_references(self):
        png=subprocess.check_output([env.get('Media__FfmpegPath','ffmpeg'),'-v','error','-f','lavfi','-i','color=c=red:s=64x64','-frames:v','1','-f','image2pipe','-vcodec','png','-'])
        uploaded=self.c.upload('acceptance.png',png,'image/png');asset=self.c.wait_media(uploaded['id']);self.assertEqual(asset['width'],64)
        self.c.request('/media/'+asset['id']);Client().request('/media/'+asset['id'],expected=404)
        asset=self.c.change('/media/'+asset['id'],{'alt':'红色方块','caption':'测试','credit':'原创','sourceUrl':'','licenseName':'','licenseUrl':''},'PATCH',asset['etag'],False)
        a=self.create();body=self.draft(a);body['coverMediaId']=asset['id'];d=self.c.change('/articles/'+a['id']+'/draft',body,'PUT',a['draft']['etag'],False);a['draft']=d;a=self.publish(a)
        Client().request('/media/'+asset['id']);self.c.change('/media/'+asset['id']+'/trash',etag=asset['etag'],expected=409)
        ref=self.c.get('/media/'+asset['id']+'/references');self.assertTrue(any(r['ownerType']=='Revision' for r in ref))
        orphan=storage/'media'/(uuid.UUID(asset['id']).hex+'.'+uuid.uuid4().hex+'.processed.stage');orphan.write_bytes(b'crash orphan')
        os.utime(orphan,(time.time()-25*3600,time.time()-25*3600))
        for _ in range(40):
            if not orphan.exists():break
            time.sleep(.1)
        self.assertFalse(orphan.exists(),'Expired processing stage must be reconciled')
    def test_11_native_rejection_and_restore(self):
        asset=self.c.upload('invalid.png',b'not an image','image/png');asset=self.c.wait_media(asset['id'],'Rejected')
        asset=self.c.change('/media/'+asset['id']+'/trash',etag=asset['etag']);asset=self.c.change('/media/'+asset['id']+'/restore',etag=asset['etag']);self.assertEqual(asset['state'],'Rejected')
        self.c.upload('../escape.png',b'x','image/png',422);self.c.upload('payload.svg',b'<svg/>','image/svg+xml',415)
    def test_12_native_video_range_delivery(self):
        video=pathlib.Path(TEMP.name)/'sample.mp4'
        subprocess.run([env.get('Media__FfmpegPath','ffmpeg'),'-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=24','-t','1','-c:v','libx264','-pix_fmt','yuv420p',str(video)],check=True)
        uploaded=self.c.upload('sample.mp4',video.read_bytes(),'video/mp4');asset=self.c.wait_media(uploaded['id']);self.assertGreater(asset['durationMs'],0)
        data,headers=self.c.request('/media/'+asset['id'],headers={'Range':'bytes=0-99'},expected=206);self.assertEqual(len(data),100);self.assertIn('Content-Range',headers)
    def test_12b_image_metadata_is_removed_and_scanner_is_live(self):
        import struct,zlib
        png=subprocess.check_output([env.get('Media__FfmpegPath','ffmpeg'),'-v','error','-f','lavfi','-i','color=c=red:s=64x64','-frames:v','1','-f','image2pipe','-vcodec','png','-'])
        # EICAR is the standard harmless antivirus test signature, inside a valid text chunk.
        text=b'Comment\x00'+b'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
        chunk=struct.pack('>I',len(text))+b'tEXt'+text+struct.pack('>I',zlib.crc32(b'tEXt'+text))
        infected=png[:-12]+chunk+png[-12:]
        asset=self.c.upload('metadata-test.png',infected,'image/png');asset=self.c.wait_media(asset['id'])
        data,_=self.c.request('/media/'+asset['id']);self.assertNotIn(b'EICAR',data);self.assertNotIn(b'tEXt',data)
        signature=pathlib.Path(TEMP.name)/'eicar-test.txt';signature.write_bytes(text.split(b'\x00',1)[1])
        scan=subprocess.run([env.get('Media__ScannerPath','clamscan'),'--no-summary','--official-db-only=yes','--database='+env.get('Media__ScannerDatabasePath','/var/lib/clamav'),str(signature)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.assertEqual(scan.returncode,1,scan.stdout.decode()+scan.stderr.decode())
        signature.unlink()
    def test_13_encrypted_backup_isolated_restore_and_tamper(self):
        self.c.change('/session/reauth',{'password':password},key=False,expected=204)
        backup=self.c.change('/maintenance/backup',expected=201);path=storage/'backups'/(backup['id']+'.felt')
        self.assertEqual(path.read_bytes()[:8],b'FELTBAK1');self.assertNotIn(password.encode(),path.read_bytes())
        target_name='felt_restore_'+prefix
        target_parts={**parts,'Database':target_name};target=';'.join(k+'='+v for k,v in target_parts.items());dest=pathlib.Path(TEMP.name)/'restored'
        sql('CREATE DATABASE "'+target_name+'"')
        cli(['--restore',str(path),'--target',env['ConnectionStrings__Blog'],'--restore-storage',str(dest)],False)
        tampered=pathlib.Path(TEMP.name)/'tampered.felt';data=bytearray(path.read_bytes());data[40]^=1;tampered.write_bytes(data)
        cli(['--restore',str(tampered),'--target',target,'--restore-storage',str(dest)],False)
        cli(['--restore',str(path),'--target',target,'--restore-storage',str(dest)])
        self.assertEqual(sql('SELECT count(*) FROM "Article"',database),sql('SELECT count(*) FROM "Article"',target_name))
        self.assertEqual(sql('SELECT count(*) FROM "AdminUser"',target_name),'0');self.assertEqual(sql('SELECT count(*) FROM "AdminSession"',target_name),'0')
        self.assertTrue(list((dest/'media').glob('*.bin')))
        cli(['--restore',str(path),'--target',target,'--restore-storage',str(pathlib.Path(TEMP.name)/'second')],False)
        sql('DROP DATABASE "'+target_name+'" WITH (FORCE)')
    def test_14_logout_revocation_and_session_expiry(self):
        copied=Client();copied.jar=clone_jar(self.c.jar);copied.open=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(copied.jar));copied.csrf=self.c.csrf
        self.c.change('/session',method='DELETE',key=False,expected=204);copied.request('/api/admin/v1/articles',expected=401)
        c=Client();c.login();sql('UPDATE "AdminSession" SET "LastSeenAt" = now() - interval \'31 minutes\'',database);c.request('/api/admin/v1/articles',expected=401)

    def test_99_restart_reset_and_repeat_seed_preserve_content(self):
        global process
        before=Client().public('/home')
        cli(['--reset-admin'])
        self.c.request('/api/admin/v1/articles',expected=401)
        process.terminate();process.wait(timeout=20)
        cli(['--seed-demo'])
        process=subprocess.Popen(command[:-1],env=env,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
        for _ in range(200):
            try:Client().request('/health/ready');break
            except OSError:time.sleep(.1)
        else:raise AssertionError('Restart did not become ready')
        self.assertEqual(Client().public('/home'),before)
        c=Client();c.login();self.assertTrue(c.get('/articles')['total']>8)

if __name__=='__main__':
    log=open(pathlib.Path(TEMP.name)/'server.log','w+')
    process=None
    try:
        cli(['--migrate','--init-admin','--seed-demo'])
        process=subprocess.Popen(command[:-1],env=env,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
        for _ in range(200):
            if process.poll() is not None:log.seek(0);raise RuntimeError(log.read()[-4000:])
            try:Client().request('/health/ready');break
            except (OSError,AssertionError):time.sleep(.1)
        else:raise RuntimeError('Application did not become ready')
        result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Acceptance))
        if not result.wasSuccessful():log.flush();log.seek(0);print(log.read()[-6000:])
        raise SystemExit(0 if result.wasSuccessful() else 1)
    finally:
        if process:process.terminate();process.wait(timeout=20)
        for name in [database,'felt_restore_'+prefix]:sql('DROP DATABASE IF EXISTS "'+name+'" WITH (FORCE)')
        log.close();TEMP.cleanup()

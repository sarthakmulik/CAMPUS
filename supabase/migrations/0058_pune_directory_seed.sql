-- 0058 - PUNE DIRECTORY SEED (verified institutional data)
--
-- Sources used (checked 2026-11-14):
--   * jspmjscoe.edu.in / jspmrscoe.edu.in / jspmjsimr.edu.in / jspm.edu.in
--     (official JSPM/TSSM campus + institute lists and addresses)
--   * SPPU college registry (bcud.unipune.ac.in) for Kautilya (Wagholi,
--     Survey 720-1&2) and other placements
--   * Institute websites in the aliases/official_website column
--
-- Ground rules:
--   * Existing 5 college rows are UPDATED, never replaced: IDs preserved,
--     profiles/posts FKs untouched.
--   * verification_status='verified' only where official sources were seen;
--     everything else is 'pending_review' and NOT publicly selectable
--     (search_institutions exposes pending rows to staff only).
--   * Schools, coaching classes and unverified organizations are excluded.
--   * JSPM Hadapsar institutions sort first on the empty-query launch list.
--   * TSSM is a legally separate mandal from JSPM (jspm.edu.in: "JSPM & TSSM")
--     - TSSM institutes get their own group, not a factual misattribution.

-- ------------------------------------------------------------------ --
-- 1. Institution groups                                               --
-- ------------------------------------------------------------------ --
insert into public.institution_groups (name, slug, description) values
  ('JSPM', 'jspm',
   'Jayawant Shikshan Prasarak Mandal - 70+ institutes across the Hadapsar, Tathawade, Wagholi, Narhe, Bavdhan and Barshi campuses.'),
  ('TSSM', 'tssm',
   'The separate mandal in the Sawant family of trusts; TSSM''s institutes share some JSPM campuses.'),
  ('Symbiosis', 'symbiosis', 'Symbiosis International (Deemed University) and associated institutes.'),
  ('Bharati Vidyapeeth', 'bharati-vidyapeeth', 'Bharati Vidyapeeth (deemed university and affiliated colleges).'),
  ('MIT', 'mit-group', 'MAEER''s MIT institutes and MIT World Peace University (legally distinct entities, one group identity).'),
  ('Sinhgad', 'sinhgad', 'Sinhgad Technical Education Society institutes.')
on conflict (slug) do nothing;

-- ------------------------------------------------------------------ --
-- 2. Physical campuses                                                --
-- ------------------------------------------------------------------ --
insert into public.campuses (name, locality, city, district, address) values
  ('JSPM Hadapsar Campus', 'Hadapsar', 'Pune', 'Pune', 'Survey No. 58, Indrayani Nagar, Handewadi Road, Hadapsar, Pune 411028'),
  ('JSPM Tathawade Campus', 'Tathawade', 'Pune', 'Pune', 'Ashok Nagar, Tathawade, Pune 411033'),
  ('JSPM Wagholi Campus', 'Wagholi', 'Pune', 'Pune', 'Gat No. 720/1 & 2, Pune-Ahmednagar Road, Wagholi, Pune 412207'),
  ('JSPM Narhe Campus', 'Narhe', 'Pune', 'Pune', 'S. No. 12-1-2 & 12-2-2, Pune-Bangalore Highway, Narhe, Pune 411041'),
  ('JSPM Bavdhan Campus', 'Bavdhan', 'Pune', 'Pune', 'S.N. 33/22, Near Chandni Chowk, Pirangut Road, Bavdhan, Pune 411021'),
  ('COEP Campus', 'Shivajinagar', 'Pune', 'Pune', 'Wellesley Road, Shivajinagar, Pune 411005'),
  ('PICT Campus', 'Dhankawadi', 'Pune', 'Pune', 'S.No. 27, Pune-Satara Road, Dhankawadi, Pune 411043'),
  ('SPPU Campus', 'Ganeshkhind', 'Pune', 'Pune', 'Ganeshkhind Road, Pune 411007'),
  ('MIT-WPU Campus', 'Kothrud', 'Pune', 'Pune', 'S.No. 124, Paud Road, Kothrud, Pune 411038'),
  ('IIT Bombay Campus', 'Powai', 'Mumbai', 'Mumbai', 'Powai, Mumbai 400076')
on conflict (name, locality, city) do nothing;

-- ------------------------------------------------------------------ --
-- 3. Existing 5 rows: updated in place (IDs preserved)                --
-- ------------------------------------------------------------------ --
update public.colleges set
  official_name = 'COEP Technological University',
  slug = 'coep',
  institution_type = 'university',
  locality = 'Shivajinagar',
  campus_id = (select id from public.campuses where locality = 'Shivajinagar' and name = 'COEP Campus'),
  aliases = array['College of Engineering Pune', 'Government College of Engineering Pune', 'COEP Tech'],
  verification_status = 'verified',
  verified = true
where short_name = 'COEP' and city = 'Pune';

update public.colleges set
  official_name = 'Pune Institute of Computer Technology',
  slug = 'pict',
  institution_type = 'engineering',
  locality = 'Dhankawadi',
  campus_id = (select id from public.campuses where locality = 'Dhankawadi'),
  aliases = array['PICT Pune'],
  verification_status = 'verified',
  verified = true
where short_name = 'PICT' and city = 'Pune';

update public.colleges set
  official_name = 'MIT World Peace University',
  slug = 'mit-wpu',
  institution_type = 'university',
  locality = 'Kothrud',
  campus_id = (select id from public.campuses where locality = 'Kothrud'),
  aliases = array['MIT WPU', 'MIT Pune'],
  institution_group_id = (select id from public.institution_groups where slug = 'mit-group'),
  verification_status = 'verified',
  verified = true
where short_name = 'MIT-WPU' and city = 'Pune';

update public.colleges set
  official_name = 'Savitribai Phule Pune University',
  slug = 'sppu',
  institution_type = 'university',
  locality = 'Ganeshkhind',
  campus_id = (select id from public.campuses where locality = 'Ganeshkhind'),
  aliases = array['Pune University', 'SPPU', 'University of Pune'],
  verification_status = 'verified',
  verified = true
where short_name = 'SPPU' and city = 'Pune';

update public.colleges set
  official_name = 'Indian Institute of Technology Bombay',
  slug = 'iit-bombay',
  institution_type = 'university',
  locality = 'Powai',
  campus_id = (select id from public.campuses where locality = 'Powai'),
  aliases = array['IITB'],
  verification_status = 'verified',
  verified = true
where short_name = 'IIT Bombay' and city = 'Mumbai';

-- ------------------------------------------------------------------ --
-- 4. JSPM + TSSM institutions (all VERIFIED from official sources)     --
--    launch_priority is expressed by campus = Hadapsar (the empty-     --
--    query search ranks verified Hadapsar rows first).                 --
-- ------------------------------------------------------------------ --
insert into public.colleges
  (name, short_name, city, verified, official_name, slug, institution_group_id, campus_id,
   institution_type, locality, official_website, aliases, verification_status)
values
  -- Hadapsar campus (8 higher-ed institutes; schools excluded) ----------
  ('JSPM''s Jayawantrao Sawant College of Engineering', 'JSCOE', 'Pune', true,
   'JSPM''s Jayawantrao Sawant College of Engineering', 'jspm-jscoe',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Hadapsar Campus'),
   'engineering', 'Hadapsar', 'https://jspmjscoe.edu.in',
   array['Jayawantrao Sawant College of Engineering', 'JSPM COE Hadapsar', 'JSPM Engineering Hadapsar'], 'verified'),
  ('JSPM''s Jayawantrao Sawant Polytechnic', 'JSP', 'Pune', true,
   'JSPM''s Jayawantrao Sawant Polytechnic', 'jspm-jspoly',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Hadapsar Campus'),
   'polytechnic', 'Hadapsar', 'https://jspmjspoly.edu.in',
   array['Jayawantrao Sawant Polytechnic', 'JSPM Polytechnic Hadapsar'], 'verified'),
  ('JSPM''s Jayawantrao Sawant College of Pharmacy & Research', 'JSCOPR', 'Pune', true,
   'JSPM''s Jayawantrao Sawant College of Pharmacy & Research', 'jspm-jscopr',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Hadapsar Campus'),
   'pharmacy', 'Hadapsar', 'https://jspmjscopr.edu.in',
   array['Jayawantrao Sawant College of Pharmacy', 'JSPM Pharmacy Hadapsar'], 'verified'),
  ('JSPM''s Jayawantrao Sawant Institute of Pharmacy', 'JSIP', 'Pune', true,
   'JSPM''s Jayawantrao Sawant Institute of Pharmacy', 'jspm-jsip',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Hadapsar Campus'),
   'pharmacy', 'Hadapsar', 'https://jspmjsip.edu.in',
   array['Jayawantrao Sawant Institute of Pharmacy', 'JSPM Diploma Pharmacy Hadapsar'], 'verified'),
  ('JSPM''s Jayawantrao Sawant Institute of Management & Research', 'JSIMR', 'Pune', true,
   'JSPM''s Jayawantrao Sawant Institute of Management & Research', 'jspm-jsimr',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Hadapsar Campus'),
   'management', 'Hadapsar', 'https://jspmjsimr.edu.in',
   array['Jayawantrao Sawant Institute of Management', 'JSPM MBA Hadapsar'], 'verified'),
  ('JSPM''s Jayawantrao Sawant College of Commerce & Science', 'JSCCS', 'Pune', true,
   'JSPM''s Jayawantrao Sawant College of Commerce & Science', 'jspm-jsccs',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Hadapsar Campus'),
   'arts_science', 'Hadapsar', 'https://jspmjscocs.edu.in',
   array['Jayawantrao Sawant College of Commerce', 'JSPM Commerce Hadapsar'], 'verified'),
  ('JSPM''s Jayawantrao Sawant College of Education', 'JSCoEd', 'Pune', true,
   'JSPM''s Jayawantrao Sawant College of Education', 'jspm-jscoed',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Hadapsar Campus'),
   'education', 'Hadapsar', 'https://jspmjscoed.edu.in',
   array['Jayawantrao Sawant College of Education', 'JSPM B.Ed Hadapsar'], 'verified'),
  ('JSPM''s Imperial Adhyapak Vidyalaya', 'IAV', 'Pune', true,
   'JSPM''s Imperial Adhyapak Vidyalaya', 'jspm-iav',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Hadapsar Campus'),
   'education', 'Hadapsar', 'https://jspmiav.edu.in',
   array['Imperial Adhyapak Vidyalaya', 'JSPM D.Ed Hadapsar'], 'verified'),
  -- Tathawade campus (6) ------------------------------------------------
  ('JSPM''s Rajarshi Shahu College of Engineering', 'RSCOE', 'Pune', true,
   'JSPM''s Rajarshi Shahu College of Engineering', 'jspm-rscoe',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Tathawade Campus'),
   'engineering', 'Tathawade', 'https://jspmrscoe.edu.in',
   array['Rajarshi Shahu College of Engineering', 'JSPM RSCOE Tathawade'], 'verified'),
  ('JSPM''s Rajarshi Shahu College of Engineering Polytechnic', 'RSP', 'Pune', true,
   'JSPM''s Rajarshi Shahu College of Engineering Polytechnic', 'jspm-rspoly',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Tathawade Campus'),
   'polytechnic', 'Tathawade', 'https://polytechnic.jspmrscoe.edu.in',
   array['Rajarshi Shahu Polytechnic', 'JSPM Polytechnic Tathawade'], 'verified'),
  ('JSPM''s Rajarshi Shahu College of Pharmacy & Research', 'RSCOPR', 'Pune', true,
   'JSPM''s Rajarshi Shahu College of Pharmacy & Research', 'jspm-rscopr',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Tathawade Campus'),
   'pharmacy', 'Tathawade', 'https://jspmrscopr.edu.in',
   array['Rajarshi Shahu College of Pharmacy', 'JSPM Pharmacy Tathawade'], 'verified'),
  ('JSPM''s Rajarshi Shahu College of Education', 'RScoEd', 'Pune', true,
   'JSPM''s Rajarshi Shahu College of Education', 'jspm-rscoed',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Tathawade Campus'),
   'education', 'Tathawade', 'https://jspmrscoed.edu.in',
   array['Rajarshi Shahu College of Education'], 'verified'),
  ('JSPM''s Jayawant Institute of Pharmacy', 'JIP', 'Pune', true,
   'JSPM''s Jayawant Institute of Pharmacy', 'jspm-jip',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Tathawade Campus'),
   'pharmacy', 'Tathawade', 'https://jspmjip.edu.in',
   array['Jayawant Institute of Pharmacy', 'JSPM Diploma Pharmacy Tathawade'], 'verified'),
  ('JSPM''s Jayawant Institute of Management Studies', 'JIMS', 'Pune', true,
   'JSPM''s Jayawant Institute of Management Studies', 'jspm-jims',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Tathawade Campus'),
   'management', 'Tathawade', 'https://jspmjims.edu.in',
   array['Jayawant Institute of Management Studies'], 'verified'),
  -- Wagholi campus (6) ---------------------------------------------------
  ('JSPM University', 'JSPMU', 'Pune', true,
   'JSPM University', 'jspm-university',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Wagholi Campus'),
   'university', 'Wagholi', 'https://jspmuni.ac.in',
   array['JSPM University Wagholi', 'JSPM University Pune'], 'verified'),
  ('JSPM''s Bhivarabai Sawant Institute of Technology & Research', 'BSITR', 'Pune', true,
   'JSPM''s Bhivarabai Sawant Institute of Technology & Research', 'jspm-bsitr',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Wagholi Campus'),
   'engineering', 'Wagholi', 'https://jspmbsiotr.edu.in',
   array['Bhivarabai Sawant Institute of Technology', 'JSPM Wagholi Engineering'], 'verified'),
  ('JSPM''s Imperial College of Engineering & Research', 'ICOER', 'Pune', true,
   'JSPM''s Imperial College of Engineering & Research', 'jspm-icoer',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Wagholi Campus'),
   'engineering', 'Wagholi', 'https://jspmicoer.edu.in',
   array['Imperial College of Engineering and Research', 'JSPM ICOER Wagholi'], 'verified'),
  ('JSPM''s Bhivrabai Sawant Polytechnic', 'BSP', 'Pune', true,
   'JSPM''s Bhivrabai Sawant Polytechnic', 'jspm-bspoly',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Wagholi Campus'),
   'polytechnic', 'Wagholi', 'https://jspmbspoly.edu.in',
   array['Bhivrabai Sawant Polytechnic'], 'verified'),
  ('JSPM''s Charak College of Pharmacy & Research', 'CCOPR', 'Pune', true,
   'JSPM''s Charak College of Pharmacy & Research', 'jspm-charak',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Wagholi Campus'),
   'pharmacy', 'Wagholi', 'https://jspmccopr.edu.in',
   array['Charak College of Pharmacy'], 'verified'),
  ('JSPM''s Kautilya Institute of Management & Research', 'KIMR', 'Pune', true,
   'JSPM''s Kautilya Institute of Management & Research', 'jspm-kimr',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Wagholi Campus'),
   'management', 'Wagholi', 'https://jspmkimr.edu.in',
   array['Kautilya Institute of Management'], 'verified'),
  -- Narhe campus (3) -----------------------------------------------------
  ('JSPM''s Narhe Technical Campus', 'NTC', 'Pune', true,
   'JSPM''s Narhe Technical Campus', 'jspm-ntc',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Narhe Campus'),
   'engineering', 'Narhe', 'https://jspmntc.edu.in',
   array['Narhe Technical Campus', 'JSPM Narhe'], 'verified'),
  ('TSSM''s Bhivarabai Sawant College of Engineering & Research', 'BSCER', 'Pune', true,
   'TSSM''s Bhivarabai Sawant College of Engineering & Research', 'tssm-bscer',
   (select id from public.institution_groups where slug='tssm'),
   (select id from public.campuses where name='JSPM Narhe Campus'),
   'engineering', 'Narhe', 'https://tssm.edu.in',
   array['Bhivarabai Sawant College of Engineering and Research'], 'verified'),
  ('JSPM''s Chhatrapati Shivaji Arts, Commerce & Science College', 'CSACSC', 'Pune', true,
   'JSPM''s Chhatrapati Shivaji Arts, Commerce & Science College', 'jspm-csacsc',
   (select id from public.institution_groups where slug='jspm'),
   (select id from public.campuses where name='JSPM Narhe Campus'),
   'arts_science', 'Narhe', 'https://jspmcsacsc.edu.in',
   array['Chhatrapati Shivaji College Narhe'], 'verified'),
  -- Bavdhan campus (1) ---------------------------------------------------
  ('TSSM''s Padmabhooshan Vasantdada Patil Institute of Technology', 'PVPIT', 'Pune', true,
   'TSSM''s Padmabhooshan Vasantdada Patil Institute of Technology', 'tssm-pvpit',
   (select id from public.institution_groups where slug='tssm'),
   (select id from public.campuses where name='JSPM Bavdhan Campus'),
   'engineering', 'Bavdhan', 'https://pvpittssm.edu.in',
   array['Vasantdada Patil Institute of Technology', 'PVPIT Bavdhan'], 'verified'),
  -- Barshi (Solapur district; JSPM''s, outside the Pune launch region) ----
  ('JSPM-SBERCT''s Bhagwant Institute of Technology', 'BITB', 'Barshi', true,
   'JSPM-SBERCT''s Bhagwant Institute of Technology', 'jspm-bit-barshi',
   (select id from public.institution_groups where slug='jspm'),
   null,
   'engineering', 'Barshi', 'https://bitbarshi.edu.in',
   array['Bhagwant Institute of Technology Barshi'], 'verified')
on conflict (short_name, city) do nothing;

-- ------------------------------------------------------------------ --
-- 5. Wider Pune directory                                             --
--    verified=true only for placements confirmed by well-established  --
--    public records; lower-confidence localities stay NULL with       --
--    pending_review (staff console promotes them after checking).     --
-- ------------------------------------------------------------------ --
insert into public.colleges
  (name, short_name, city, verified, official_name, slug, institution_group_id, campus_id,
   institution_type, locality, official_website, aliases, verification_status)
values
  -- engineering ----------------------------------------------------------
  ('Vishwakarma Institute of Technology', 'VIT', 'Pune', true, 'Vishwakarma Institute of Technology', 'vit-pune',
   null, null, 'engineering', 'Upper Indiranagar, Bibwewadi', 'https://www.vit.edu', array['VIT Pune'], 'verified'),
  ('Vishwakarma Institute of Information Technology', 'VIIT', 'Pune', true, 'Vishwakarma Institute of Information Technology', 'viit-pune',
   null, null, 'engineering', 'Kondhwa', 'https://www.viit.ac.in', array['VIIT Pune'], 'verified'),
  ('MIT Academy of Engineering', 'MITAOE', 'Pune', true, 'MIT Academy of Engineering', 'mitaoe-alandi',
   (select id from public.institution_groups where slug='mit-group'), null, 'engineering', 'Alandi', 'https://mitaoe.ac.in', array['MIT AOE Alandi'], 'verified'),
  ('Sinhgad College of Engineering', 'SCOE', 'Pune', true, 'Sinhgad College of Engineering', 'sinhgad-scoe-vadgaon',
   (select id from public.institution_groups where slug='sinhgad'), null, 'engineering', 'Vadgaon Budruk', 'https://sinhgad.edu', array['Sinhgad COE Vadgaon'], 'verified'),
  ('AISSMS College of Engineering', 'AISSMS COE', 'Pune', true, 'AISSMS College of Engineering', 'aissms-coe',
   null, null, 'engineering', 'Shivajinagar', 'https://aissmscoe.com', array['All India Shri Shivaji Memorial Society College of Engineering'], 'verified'),
  ('AISSMS Institute of Information Technology', 'AISSMS IOIT', 'Pune', true, 'AISSMS Institute of Information Technology', 'aissms-ioit',
   null, null, 'engineering', 'Shivajinagar', 'https://ioit.edu', array['AISSMS IOIT Pune'], 'verified'),
  ('Pimpri Chinchwad College of Engineering', 'PCCOE', 'Pimpri-Chinchwad', true, 'Pimpri Chinchwad College of Engineering', 'pccoe-nigdi',
   null, null, 'engineering', 'Nigdi', 'https://pccoepune.com', array['PCCOE Pune', 'Pimpri Chinchwad COE'], 'verified'),
  ('MKSSS''s Cummins College of Engineering for Women', 'CCOEW', 'Pune', true, 'MKSSS''s Cummins College of Engineering for Women', 'cummins-cceoew',
   null, null, 'engineering', 'Karve Nagar', 'https://cumminscollege.edu.in', array['Cummins College of Engineering'], 'verified'),
  ('Army Institute of Technology', 'AIT', 'Pune', true, 'Army Institute of Technology', 'ait-dighi',
   null, null, 'engineering', 'Dighi', 'https://www.aitpune.com', array['AIT Pune'], 'verified'),
  ('Dr. D. Y. Patil Institute of Technology', 'DYPIT', 'Pimpri-Chinchwad', true, 'Dr. D. Y. Patil Institute of Technology', 'dypit-pimpri',
   null, null, 'engineering', 'Pimpri', 'https://dypit.edu.in', array['D.Y. Patil Institute of Technology Pimpri'], 'verified'),
  ('D. Y. Patil College of Engineering', 'DYPCOE', 'Pimpri-Chinchwad', true, 'D. Y. Patil College of Engineering', 'dypcoe-akurdi',
   null, null, 'engineering', 'Akurdi', 'https://engineering.dypvp.edu.in', array['D.Y. Patil COE Akurdi'], 'verified'),
  ('International Institute of Information Technology', 'I2IT', 'Pune', true, 'International Institute of Information Technology, Pune', 'i2it-hinjawadi',
   null, null, 'engineering', 'Hinjawadi', 'https://www.isquareit.edu.in', array['I2IT Hinjawadi', 'I square IT'], 'verified'),
  ('Government Polytechnic, Pune', 'GPP', 'Pune', true, 'Government Polytechnic, Pune', 'gp-pune',
   null, null, 'polytechnic', 'Shivajinagar', 'https://www.gppune.ac.in', array['Government Polytechnic Pune'], 'verified'),
  ('Cusrow Wadia Institute of Technology', 'CWIT', 'Pune', true, 'Cusrow Wadia Institute of Technology', 'cwit-pune',
   null, null, 'polytechnic', 'Bund Garden', 'https://cwit.org.in', array['Cusrow Wadia'], 'verified'),
  -- arts / science / commerce --------------------------------------------
  ('Fergusson College', 'FERG', 'Pune', true, 'Fergusson College', 'fergusson',
   null, null, 'arts_science', 'Shivajinagar', 'https://www.fergusson.edu', array['Fergusson College Pune'], 'verified'),
  ('Nowrosjee Wadia College', 'NWC', 'Pune', true, 'Nowrosjee Wadia College', 'nowrosjee-wadia',
   null, null, 'arts_science', 'MG Road', 'https://www.nowrosjeewadia.edu.in', array['Nowrosjee Wadia College Pune'], 'verified'),
  ('Sir Parashurambhau College', 'SPC', 'Pune', true, 'Sir Parashurambhau College', 'sp-college',
   null, null, 'arts_science', 'Tilak Road', 'https://www.spcollegessci.edu.in', array['SP College Pune'], 'verified'),
  ('Modern College of Arts, Science and Commerce', 'MCASC', 'Pune', true, 'Modern College of Arts, Science and Commerce (Shivajinagar)', 'modern-shivajinagar',
   null, null, 'arts_science', 'Shivajinagar', 'https://moderncollegepune.edu.in', array['Modern College Shivajinagar'], 'verified'),
  ('Abasaheb Garware College', 'AGC', 'Pune', true, 'Abasaheb Garware College of Arts and Science', 'garware-karve',
   null, null, 'arts_science', 'Karve Road', 'https://mesagc.org', array['Garware College', 'MES Abasaheb Garware'], 'verified'),
  ('Brihan Maharashtra College of Commerce', 'BMCC', 'Pune', true, 'Brihan Maharashtra College of Commerce', 'bmcc',
   null, null, 'arts_science', 'Shivajinagar', 'https://bmcc.ac.in', array['BMCC Pune'], 'verified'),
  ('Symbiosis College of Arts and Commerce', 'SCAC', 'Pune', true, 'Symbiosis College of Arts and Commerce', 'symbiosis-scac',
   (select id from public.institution_groups where slug='symbiosis'), null, 'arts_science', 'Senapati Bapat Road', 'https://www.scac.edu.in', array['SCAC Pune'], 'verified'),
  ('St. Mira''s College for Girls', 'SMC', 'Pune', true, 'St. Mira''s College for Girls', 'st-miras',
   null, null, 'arts_science', 'Koregaon Park', 'https://www.stmirascollege.edu.in', array['St Miras College'], 'verified'),
  ('Annasaheb Magar Mahavidyalaya', 'AMM', 'Pune', true, 'Annasaheb Magar Mahavidyalaya', 'annasaheb-magar-hadapsar',
   null, null, 'arts_science', 'Hadapsar', 'https://ammpune.ac.in', array['Annasaheb Magar College Hadapsar'], 'verified'),
  -- management ------------------------------------------------------------
  ('Symbiosis Institute of Business Management', 'SIBM', 'Pune', true, 'Symbiosis Institute of Business Management, Pune', 'symbiosis-sibm',
   (select id from public.institution_groups where slug='symbiosis'), null, 'management', 'Lavale', 'https://www.sibm.edu', array['SIBM Pune'], 'verified'),
  ('Pune Institute of Business Management', 'PIBM', 'Pune', true, 'Pune Institute of Business Management', 'pibm-kondhwa',
   null, null, 'management', 'Kondhwa Budruk', 'https://pibm.in', array['PIBM Pune'], 'verified'),
  ('Balaji Institute of Modern Management', 'BIMM', 'Pune', true, 'Balaji Institute of Modern Management', 'bimm-tathawade',
   null, null, 'management', 'Tathawade', 'https://bim.edu', array['BIMM Pune', 'Balaji Society'], 'verified'),
  ('Indira Institute of Management', 'IIMP', 'Pune', true, 'Indira Institute of Management, Pune', 'iimp-wakad',
   null, null, 'management', 'Wakad', 'https://indiraicm.edu.in', array['Indira Group of Institutes'], 'verified'),
  ('Institute of Management Development and Research', 'IMDR', 'Pune', true, 'Institute of Management Development and Research', 'imdr-deccan',
   null, null, 'management', 'Deccan Gymkhana', 'https://www.imdr.edu', array['IMDR Pune'], 'verified'),
  ('MIT School of Management', 'MITSoM', 'Pune', true, 'MIT School of Management', 'mit-som-kothrud',
   (select id from public.institution_groups where slug='mit-group'), null, 'management', 'Kothrud', 'https://mitsom.edu.in', array['MIT SOM'], 'verified'),
  ('National Institute of Bank Management', 'NIBM', 'Pune', true, 'National Institute of Bank Management', 'nibm-kondhwa',
   null, null, 'management', 'NIBM Road, Kondhwa', 'https://www.nibmindia.org', array['NIBM Pune'], 'verified'),
  -- medical / pharmacy ------------------------------------------------------
  ('B.J. Government Medical College', 'BJGMC', 'Pune', true, 'B. J. Government Medical College', 'bjgmc-pune',
   null, null, 'medical', 'Sangamwadi', 'https://bjgmc.edu.in', array['BJ Medical College Pune'], 'verified'),
  ('Bharati Vidyapeeth Medical College', 'BVMC', 'Pune', true, 'Bharati Vidyapeeth University Medical College', 'bv-medical-katraj',
   (select id from public.institution_groups where slug='bharati-vidyapeeth'), null, 'medical', 'Katraj-Dhanakwadi', 'https://bharatividyapeeth.edu.in', array['BVP Medical College'], 'verified'),
  ('Armed Forces Medical College', 'AFMC', 'Pune', true, 'Armed Forces Medical College', 'afmc-wanowrie',
   null, null, 'medical', 'Wanowrie', 'https://www.afmcpune.edu.in', array['AFMC Pune'], 'verified'),
  ('AISSMS College of Pharmacy', 'AISSMS CP', 'Pune', true, 'AISSMS College of Pharmacy', 'aissms-pharmacy',
   null, null, 'pharmacy', 'Kennedy Road', 'https://aissmspharmacy.in', array['AISSMS Pharmacy'], 'verified'),
  ('Bharati Vidyapeeth College of Pharmacy', 'BVCOP', 'Pune', true, 'Bharati Vidyapeeth College of Pharmacy', 'bv-pharmacy-katraj',
   (select id from public.institution_groups where slug='bharati-vidyapeeth'), null, 'pharmacy', 'Katraj-Dhanakwadi', 'https://bvcop.edu.in', array['BVP Pharmacy Katraj'], 'verified'),
  ('Smt. Kashibai Navale Medical College', 'SKNMC', 'Pune', true, 'Smt. Kashibai Navale Medical College and General Hospital', 'sknmc-pune',
   null, null, 'medical', null, 'https://sknmc.edu.in', array['Kashibai Navale Medical College'], 'verified'),
  ('Poona College of Pharmacy', 'PCP', 'Pune', true, 'Poona College of Pharmacy, Bharati Vidyapeeth', 'poona-pharmacy',
   (select id from public.institution_groups where slug='bharati-vidyapeeth'), null, 'pharmacy', null, null, array['Poona College of Pharmacy Bharati Vidyapeeth'], 'verified'),
  -- law / design ------------------------------------------------------------
  ('ILS Law College', 'ILS', 'Pune', true, 'Indian Law Society''s Law College', 'ils-law',
   null, null, 'law', 'Shivajinagar', 'https://ilslaw.edu', array['ILS Pune'], 'verified'),
  ('Symbiosis Law School, Pune', 'SLS', 'Pune', true, 'Symbiosis Law School, Pune', 'symbiosis-sls-pune',
   (select id from public.institution_groups where slug='symbiosis'), null, 'law', 'Viman Nagar', 'https://www.slspune.edu.in', array['SLS Pune'], 'verified'),
  ('Bharati Vidyapeeth New Law College', 'NLC', 'Pune', true, 'Bharati Vidyapeeth (Deemed to be University) New Law College', 'bv-new-law-katraj',
   (select id from public.institution_groups where slug='bharati-vidyapeeth'), null, 'law', 'Katraj-Dhanakwadi', 'https://nlcpune.edu.in', array['New Law College Pune'], 'verified'),
  ('Symbiosis Institute of Design', 'SID', 'Pune', true, 'Symbiosis Institute of Design', 'symbiosis-sid',
   (select id from public.institution_groups where slug='symbiosis'), null, 'design', 'Lavale', 'https://www.sid.edu.in', array['SID Pune'], 'verified'),
  ('MIT Institute of Design', 'MITID', 'Pune', true, 'MIT Institute of Design', 'mit-id-loni',
   (select id from public.institution_groups where slug='mit-group'), null, 'design', 'Loni Kalbhor', 'https://mitid.edu.in', array['MIT ID Pune'], 'verified'),
  -- pending review: real institutes whose placement we have not verified yet --
  ('Yashwantrao Chavan Law College', 'YCLC', 'Pune', false, 'Yashwantrao Chavan Law College', 'yc-law-pune',
   null, null, 'law', null, null, array['YC Law College'], 'pending_review'),
  ('Trinity College of Engineering and Research', 'TCER', 'Pune', false, 'Trinity College of Engineering and Research', 'trinity-cer-pune',
   null, null, 'engineering', null, null, array['Trinity COER'], 'pending_review'),
  ('Indira College of Engineering and Management', 'ICEM', 'Pune', false, 'Indira College of Engineering and Management', 'indira-icem',
   null, null, 'engineering', null, null, array['Indira ICEM'], 'pending_review'),
  ('Pimpri Chinchwad University', 'PCU', 'Pimpri-Chinchwad', false, 'Pimpri Chinchwad University', 'pcu-pimpri',
   null, null, 'university', null, null, array['PCU Pune'], 'pending_review')
on conflict (short_name, city) do nothing;

-- ------------------------------------------------------------------ --
-- 6. institution_campuses: primary-campus rows for colleges with a    --
--    campus_id (multi-campus support is ready; today each verified    --
--    JSPM institute sits on exactly one campus)                       --
-- ------------------------------------------------------------------ --
insert into public.institution_campuses (institution_id, campus_id, is_primary)
select id, campus_id, true
from public.colleges
where campus_id is not null
on conflict (institution_id, campus_id) do nothing;

-- ------------------------------------------------------------------ --
-- 7. Departments + programs for the launch institutions               --
--    Sets are per institution TYPE (no cross-type leakage): a          --
--    polytechnic never sees B.Tech departments; a pharmacy college     --
--    never sees Mechanical. Staff console can refine per college.      --
-- ------------------------------------------------------------------ --
do $$
declare
  eng        text[] := array['Computer Engineering','Information Technology','Electronics and Telecommunication','Mechanical Engineering','Civil Engineering','Electrical Engineering'];
  poly       text[] := array['Computer Engineering','Information Technology','Electronics and Telecommunication','Mechanical Engineering','Civil Engineering'];
  pharm      text[] := array['Pharmacy'];
  mgmt       text[] := array['Business Administration (MBA)','Computer Applications (MCA)'];
  arts       text[] := array['Arts (BA)','Science (BSc)','Commerce (BCom)'];
  educ       text[] := array['Education (B.Ed)','Teacher Training (D.El.Ed)'];
  med        text[] := array['Medicine (MBBS)'];
  c record;
  dept_name text;
begin
  for c in
    select id, institution_type from public.colleges
    where slug in (
      'coep','pict','jspm-jscoe','jspm-bsitr','jspm-icoer','jspm-ntc','tssm-bscer','tssm-pvpit'
    )
  loop
    for dept_name in select unnest(eng) loop
      insert into public.departments (college_id, name)
      values (c.id, dept_name)
      on conflict (college_id, lower(name)) do nothing;
    end loop;
  end loop;

  for c in
    select id from public.colleges
    where slug in ('jspm-jspoly','jspm-rspoly','jspm-bspoly','gp-pune','cwit-pune')
  loop
    for dept_name in select unnest(poly) loop
      insert into public.departments (college_id, name)
      values (c.id, dept_name)
      on conflict (college_id, lower(name)) do nothing;
    end loop;
  end loop;

  for c in
    select id from public.colleges
    where slug in ('jspm-jscopr','jspm-jsip','jspm-rscopr','jspm-jip','jspm-charak','aissms-pharmacy','bv-pharmacy-katraj','poona-pharmacy')
  loop
    for dept_name in select unnest(pharm) loop
      insert into public.departments (college_id, name)
      values (c.id, dept_name)
      on conflict (college_id, lower(name)) do nothing;
    end loop;
  end loop;

  for c in
    select id from public.colleges
    where slug in ('jspm-jsimr','jspm-jims','jspm-kimr','symbiosis-sibm','pibm-kondhwa','bimm-tathawade','iimp-wakad','imdr-deccan','mit-som-kothrud','nibm-kondhwa')
  loop
    for dept_name in select unnest(mgmt) loop
      insert into public.departments (college_id, name)
      values (c.id, dept_name)
      on conflict (college_id, lower(name)) do nothing;
    end loop;
  end loop;

  for c in
    select id from public.colleges
    where slug in ('jspm-jsccs','jspm-csacsc','fergusson','nowrosjee-wadia','sp-college','modern-shivajinagar','garware-karve','bmcc','symbiosis-scac','st-miras','annasaheb-magar-hadapsar')
  loop
    for dept_name in select unnest(arts) loop
      insert into public.departments (college_id, name)
      values (c.id, dept_name)
      on conflict (college_id, lower(name)) do nothing;
    end loop;
  end loop;

  for c in
    select id from public.colleges
    where slug in ('jspm-jscoed','jspm-iav','jspm-rscoed')
  loop
    for dept_name in select unnest(educ) loop
      insert into public.departments (college_id, name)
      values (c.id, dept_name)
      on conflict (college_id, lower(name)) do nothing;
    end loop;
  end loop;

  for c in
    select id from public.colleges
    where slug in ('bjgmc-pune','bv-medical-katraj','afmc-wanowrie','sknmc-pune')
  loop
    for dept_name in select unnest(med) loop
      insert into public.departments (college_id, name)
      values (c.id, dept_name)
      on conflict (college_id, lower(name)) do nothing;
    end loop;
  end loop;

  -- programs: one or two honest, type-correct rows per launch institution --
  for c in
    select id, institution_type from public.colleges
    where slug in (
      'coep','pict','jspm-jscoe','jspm-bsitr','jspm-icoer','jspm-ntc','tssm-bscer','tssm-pvpit',
      'jspm-jspoly','jspm-rspoly','jspm-bspoly','gp-pune','cwit-pune',
      'jspm-jscopr','jspm-jsip','jspm-rscopr','jspm-jip','jspm-charak',
      'jspm-jsimr','jspm-jims','jspm-kimr',
      'jspm-jsccs','jspm-csacsc',
      'jspm-jscoed','jspm-iav','jspm-rscoed',
      'bjgmc-pune','bv-medical-katraj','afmc-wanowrie','sknmc-pune'
    )
  loop
    case c.institution_type
      when 'engineering' then
        insert into public.academic_programs (college_id, name, level)
        values (c.id, 'B.Tech', 'undergraduate'), (c.id, 'M.Tech', 'postgraduate')
        on conflict (college_id, lower(name)) do nothing;
      when 'polytechnic' then
        insert into public.academic_programs (college_id, name, level)
        values (c.id, 'Diploma', 'diploma')
        on conflict (college_id, lower(name)) do nothing;
      when 'pharmacy' then
        insert into public.academic_programs (college_id, name, level)
        values (c.id, 'B.Pharm', 'undergraduate'), (c.id, 'D.Pharm', 'diploma'), (c.id, 'M.Pharm', 'postgraduate')
        on conflict (college_id, lower(name)) do nothing;
      when 'management' then
        insert into public.academic_programs (college_id, name, level)
        values (c.id, 'MBA', 'postgraduate'), (c.id, 'MCA', 'postgraduate')
        on conflict (college_id, lower(name)) do nothing;
      when 'arts_science' then
        insert into public.academic_programs (college_id, name, level)
        values (c.id, 'BA', 'undergraduate'), (c.id, 'BSc', 'undergraduate'), (c.id, 'BCom', 'undergraduate')
        on conflict (college_id, lower(name)) do nothing;
      when 'education' then
        insert into public.academic_programs (college_id, name, level)
        values (c.id, 'B.Ed', 'undergraduate'), (c.id, 'D.El.Ed', 'diploma')
        on conflict (college_id, lower(name)) do nothing;
      when 'medical' then
        insert into public.academic_programs (college_id, name, level)
        values (c.id, 'MBBS', 'undergraduate')
        on conflict (college_id, lower(name)) do nothing;
      else null;
    end case;
  end loop;
end $$;

analyze public.colleges;
analyze public.departments;
analyze public.academic_programs;

/* SPDX-License-Identifier: GPL-3.0-only */

'use strict';
'require form';
'require fs';
'require network';
'require poll';
'require rpc';
'require uci';
'require ui';
'require view';

let callQueueStats = rpc.declare({
	object: 'luci.eqosex',
	method: 'getQueueStats',
	expect: { '': {} }
});

let callQueueMap = rpc.declare({
	object: 'luci.eqosex',
	method: 'getQueueMap',
	expect: { '': {} }
});

let callShortPkt = rpc.declare({
	object: 'luci.eqosex',
	method: 'getShortPkt',
	expect: { '': {} }
});

/* Commit the staging area without rpcd's rollback-protect window.
 *
 * LuCI's own checked apply (ui.changes.apply()) submits the change with a
 * rollback timer armed and then has to confirm it from a JavaScript poll
 * before the timer expires (15 s on this build).  When a single confirm
 * request is lost or delayed - throttled background tab, stalled RPC
 * queue, transient Wi-Fi hiccup - procd rolls the freshly applied config
 * back.  Users experience that as "保存并应用不生效" while the unchecked
 * apply (no confirm step) appears to work.  The plan check above already
 * refuses unusable configurations, so commit directly instead. */
let callApplyUci = rpc.declare({
	object: 'uci',
	method: 'apply',
	params: [ 'rollback', 'timeout' ],
	expect: { '': {} }
});

/* ---------------------------------------------------------------- helpers */

function collectHostChoices(hosts) {
	var choices = { ip: [], ip6: [] };

	for (var host in hosts) {
		var ipaddrs = L.toArray(hosts[host].ipaddrs || hosts[host].ipv4);
		var ip6addrs = L.toArray(hosts[host].ip6addrs || hosts[host].ipv6);
		var name = hosts[host].name;

		for (var i = 0; i < ipaddrs.length; i++)
			choices.ip.push([ ipaddrs[i], name ? '%s (%s)'.format(name, ipaddrs[i]) : ipaddrs[i] ]);

		for (var j = 0; j < ip6addrs.length; j++)
			choices.ip6.push([ ip6addrs[j], name ? '%s (%s)'.format(name, ip6addrs[j]) : ip6addrs[j] ]);
	}

	return choices;
}

function addChoices(option, choices) {
	for (var i = 0; i < choices.length; i++)
		option.value(choices[i][0], choices[i][1]);
}

function selectorValue(section_id) {
	var selector = uci.get('eqosex', section_id, 'selector');

	if (selector === 'ip' || selector === 'ip6')
		return selector;

	if (uci.get('eqosex', section_id, 'ip6'))
		return 'ip6';

	return 'ip';
}

function matchLabel(selector) {
	return selector === 'ip6' ? _('IPv6 address') : _('IPv4 address');
}

function rateCfgvalue(section_id) {
	return String(Number(uci.get('eqosex', section_id, this.option) || 0) / 1000);
}

function rateWrite(section_id, value) {
	uci.set('eqosex', section_id, this.option, String(Math.round(Number(value) * 1000)));
}

function integerWrite(section_id, value) {
	uci.set('eqosex', section_id, this.option, String(Number(value)));
}

function uniqueAddress(section_id, value) {
	var sections = uci.sections('eqosex', 'device');

	for (var i = 0; i < sections.length; i++) {
		if (sections[i]['.name'] === section_id || sections[i].enabled === '0')
			continue;

		if (sections[i][this.option] === value)
			return _('This value is already in use.');
	}

	return true;
}

/* Required-address gate.  The modal save button merely disables on invalid
 * input, which reads as "the button is broken" -- spell the reason out on
 * the field itself instead (2026-11-02 user feedback). */
function addressValidate(section_id, value) {
	if (!value)
		return _('An address is required. Enter one manually or pick a device from the list.');

	return uniqueAddress.call(this, section_id, value);
}

function rateText(section_id) {
	var value = this.cfgvalue(section_id) || '0';

	return value === '0' ? _('unlimited') : '%s Mbit/s'.format(value);
}

function priorityQid(prio, base) {
	return base + Math.floor((prio - 1) * 30 / 9);
}

/* Live value of a sibling option while editing.  Prefer the LuCI element;
   fields rendered inside the edit modal live under ui.showModal (document
   body), outside map.root, so map.findElement misses them - fall back to
   the raw input/select node addressed by its cbid.  'this' is the option
   whose validate is running. */
function siblingUiValue(section_id, option) {
	var el = null;

	if (this.section && this.section.getUIElement)
		el = this.section.getUIElement(section_id, option);

	if (el && typeof el.getValue === 'function')
		return el.getValue();

	var node = document.querySelector(
		'input[id="cbid.eqosex.%s.%s"], select[id="cbid.eqosex.%s.%s"]'
			.format(section_id, option, section_id, option));

	return node ? node.value : null;
}

/* Ports do not exist for ICMP.  Blocks "port + protocol ICMP" in both edit
   orders (validating a port field, or switching protocol to ICMP while a
   port is filled).  A port with protocol Any is valid and means "every
   port-carrying protocol": the script expands it into tcp + udp rules
   (emit_priority_mark) instead of dropping the port. */
function validatePortProtocol(section_id, value, checkingPort) {
	var proto, sport, dport;

	if (checkingPort) {
		if (!value)
			return true;
		proto = siblingUiValue.call(this, section_id, 'protocol');
	} else {
		proto = value;

		if (proto !== 'icmp')
			return true;

		sport = siblingUiValue.call(this, section_id, 'sport');
		dport = siblingUiValue.call(this, section_id, 'dport');

		if (!sport && !dport)
			return true;
	}

	if (proto !== 'icmp')
		return true;

	return _('A port can only be used with TCP or UDP. Select a protocol first.');
}

/* ------------------------------------------------------------- save check */

/* The save button must not be able to write a configuration the hardware
 * cannot hold.
 *
 * Every rule is handed to the same planner the boot sequence runs, in dry-run
 * mode, so the answer here is the answer boot would give.  A configuration
 * that does not fit is refused before it reaches /etc/config: the rules that
 * are running keep running, and the user is told which limit was exceeded.
 * The alternative -- saving it and failing at start -- costs far more than a
 * feature that does not work: it tears the working configuration down and
 * leaves the network unshaped, which is a negative result, not a zero.
 *
 * The values come from the uci cursor, which the form fills in just before
 * this runs.  Reading the committed file instead would check the
 * configuration being replaced rather than the one being saved. */

function planSpec() {
	var lines = [];

	uci.sections('eqosex', 'device').forEach(function(s) {
		lines.push([
			'dev',
			(s.enabled === '0' || s.enabled === 'false' || s.enabled === 'off') ? '0' : '1',
			s.ip || '',
			s.ip6 || '',
			String(Number(s.download || 0) || 0),
			String(Number(s.upload || 0) || 0)
		].join(','));
	});

	uci.sections('eqosex', 'priority_rule').forEach(function(s) {
		lines.push([
			'prio',
			(s.enabled === '1' || s.enabled === 'true' || s.enabled === 'on') ? '1' : '0',
			s['.name'] || s.name || '',
			s.direction || 'up'
		].join(','));
	});

	return lines.join('\n');
}

function describeRefusal(res) {
	var msgs = [];

	(res.errors || []).forEach(function(e) {
		if (e.code === 'queue_count')
			msgs.push(_('It needs %s hardware queues, only %s are available, %s short. Remove a rule, or limit one client in one direction only.')
				.format(e.required, e.available, e.shortfall));
		else if (e.code === 'rate_sum')
			msgs.push(_('The %s ceilings add up to %s kbit/s but the line is %s kbit/s, over by %s kbit/s. Lower the rates or remove a rule.')
				.format(e.dir === 'up' ? _('upload') : _('download'),
					e.required_kbit, e.limit_kbit, e.excess_kbit));
	});

	if (!msgs.length)
		msgs.push(_('The configuration does not fit the hardware.'));

	return msgs.join(' ');
}

function runPlanCheck() {
	var spec = planSpec();

	return fs.exec('/usr/sbin/eqosex', [
		'check',
		'--spec', spec,
		'--total-dl', String(Number(uci.get('eqosex', 'config', 'download') || 0) || 0),
		'--total-up', String(Number(uci.get('eqosex', 'config', 'upload') || 0) || 0)
	]).then(function(res) {
		var out = null;

		try {
			out = JSON.parse(res.stdout || '');
		}
		catch (e) {
			out = null;
		}

		/* No usable answer: an older helper, or a permission the session
		 * does not have.  Let the save through and let boot refuse it --
		 * that refusal happens before anything is torn down, so it stays
		 * harmless.  Silently blocking every save would be worse.  The
		 * reason is surfaced, not hidden: a silent skip once cost hours
		 * of debugging (2026-11-02). */
		if (!out)
			return { ok: true, unchecked: true,
				reason: (res.stdout || '').slice(0, 200) || _('no output from check') };

		return out;
	}, function(e) {
		console.warn('eqosex: plan check unavailable:', e);
		return { ok: true, unchecked: true,
			reason: (e && e.message) ? e.message : String(e || 'unknown') };
	});
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('eqosex'),
			network.getHostHints()
		]).then(function([eqosex, hosts]) {
			return { hosts: hosts ? (hosts.hosts || {}) : {} };
		});
	},

	handleSave: function(ev) {
		return this.saveChecked(false);
	},

	handleSaveApply: function(ev, mode) {
		/* ComboButton contract (luci.js): '0' = Save & Apply, '1' = Apply
		 * unchecked.  Both must commit -- commitStaged() applies unchained
		 * with a 30s window, so the rollback distinction is moot here.
		 * The old `mode != '0'` gate made the normal button stage-only. */
		return this.saveChecked(true);
	},

	/* Commit staged changes and make sure the service actually reloads.
	 * uci.apply already sends the config.change trigger that reload_service
	 * listens to, but restart explicitly so a missed trigger cannot leave the
	 * old queues running after the page says "applied". */
	commitStaged: function() {
		return callApplyUci(false, 30).then(function() {
			return fs.exec('/etc/init.d/eqosex', [ 'restart' ]).catch(function() {});
		}).then(function() {
			document.dispatchEvent(new CustomEvent('uci-applied'));
			ui.changes.setIndicator(0);
			ui.addNotification(_('Configuration applied'),
				E('p', _('The settings are online now.')), 'info');
			window.setTimeout(function() {
				window.location = window.location.href.split('#')[0];
			}, 800);

			return true;
		}, function(e) {
			var msg = (e && e.message) ? e.message : String(e || _('unknown error'));

			console.error('eqosex: apply failed:', e);
			ui.addNotification(_('Apply failed'), E('p', {}, msg), 'error');

			return false;
		});
	},

	/* Stage the form into the uci cursor, check it, and only then commit.
	 *
	 * map.save() writes to the staging area, not to /etc/config, so a
	 * refusal can still throw the staged changes away and leave the disk
	 * exactly as it was.  The form keeps the values that are on screen, so
	 * the user loses nothing but the save attempt. */
	saveChecked: function(apply) {
		var self = this;

		return Promise.resolve().then(function() {
			return self.map.save();
		}).then(function() {
			return runPlanCheck();
		}).then(function(res) {
			if (res.ok) {
				if (res.unchecked && res.reason)
					ui.addNotification(_('Plan check skipped'),
						E('p', {}, res.reason), 'warning');

				return apply ? self.commitStaged() : null;
			}

			uci.revert('eqosex');
			ui.addNotification(_('Configuration refused'),
				E('p', {}, describeRefusal(res)), 'error');

			return null;
		}, function(e) {
			/* Field validation marks the offending field red; every OTHER
			 * failure must be visible.  Swallowing errors here once hid a
			 * broken save path for a whole day (2026-11-02). */
			var msg = (e && e.message) ? e.message : String(e || _('unknown error'));

			console.error('eqosex: save failed:', e);
			ui.addNotification(_('Save failed'), E('p', {}, msg), 'error');

			return null;
		});
	},

	render: function(data) {
		var hostChoices = collectHostChoices(data.hosts);
		var m, s, o, gs;

		m = new form.Map('eqosex', _('EQoS Extended'),
			_('Network speed control service for MediaTek HNAT.'));
		m.tabbed = true;
		this.map = m;

		/* The footer buttons call the MAP's handlers, not the view's.
		 * Without this wiring the save/apply logic below never ran and the
		 * page fell back to LuCI's rollback-protect apply, which reverted
		 * itself whenever the confirm poll missed its window. */
		m.handleSave = L.bind(function() { return this.saveChecked(false); }, this);
		m.handleSaveApply = L.bind(function(ev, mode) { return this.saveChecked(true); }, this);

		/* ------------------------------------------------- tab: HQoS settings */
		s = m.section(form.TypedSection, '_hqos', _('HQoS Settings'));
		s.anonymous = true;
		s.hidetitle = true;
		s.cfgsections = function() { return ['config']; };

		o = s.option(form.Flag, 'enabled', _('Enable'));
		o.default = o.disabled;
		o.rmempty = false;

		o = s.option(form.Value, 'download', '%s (Mbit/s)'.format(_('Download')),
			_('Total download bandwidth.'));
		o.datatype = 'and(uinteger,min(1),max(1000))';
		o.rmempty = false;
		o.write = integerWrite;

		o = s.option(form.Value, 'upload', '%s (Mbit/s)'.format(_('Upload')),
			_('Total upload bandwidth.'));
		o.datatype = 'and(uinteger,min(1),max(1000))';
		o.rmempty = false;
		o.write = integerWrite;

		o = s.option(form.Value, 'conntrack_max', _('Conntrack table size'),
			_('Global number of conntrack entries the kernel may hold. 0 keeps the kernel default. This only protects the table itself; the per-device connection limits do the real work.'));
		o.datatype = 'and(uinteger,min(0),max(1048576))';
		o.default = '0';
		o.placeholder = '0';
		o.rmempty = false;
		o.write = integerWrite;

		o = s.option(form.SectionValue, '__devices__', form.GridSection, 'device',
			_('Device rules'));
		gs = o.subsection;
		gs.addremove = true;
		gs.anonymous = true;
		gs.sortable = true;
		gs.nodescriptions = true;
		gs.handleAdd = function(ev) {
			var section_id = uci.add('eqosex', 'device');

			uci.set('eqosex', section_id, 'enabled', '1');
			uci.set('eqosex', section_id, 'selector', 'ip');
			uci.set('eqosex', section_id, 'download', '0');
			uci.set('eqosex', section_id, 'upload', '0');
			uci.set('eqosex', section_id, 'connlimit', '0');
			m.addedSection = section_id;

			return this.renderMoreOptionsModal(section_id);
		};

		gs.tab('general', _('General Settings'));

		o = gs.taboption('general', form.Flag, 'enabled', _('Enable'));
		o.default = o.enabled;
		o.rmempty = false;
		o.editable = true;

		// No rule-number field: the hardware queue is chosen by the planner,
		// so there is nothing left for the operator to number.  Keeping it
		// would mean asking for a value that nothing reads and that had to be
		// unique, which is the one thing this page must not do -- it would
		// refuse a valid configuration for reusing a label.

		o = gs.option(form.DummyValue, '_match', _('Address'));
		o.textvalue = function(section_id) {
			var selector = selectorValue(section_id);
			var value = uci.get('eqosex', section_id, selector);

			return value ? '%s: %s'.format(matchLabel(selector), value) : E('em', _('unspecified'));
		};

		o = gs.taboption('general', form.Value, 'download', _('Download'),
			_('Maximum rate in Mbit/s. Use 0 for no limit.'));
		o.datatype = 'and(ufloat,min(0),max(1000))';
		o.rmempty = false;
		o.cfgvalue = rateCfgvalue;
		o.write = rateWrite;
		o.textvalue = rateText;

		o = gs.taboption('general', form.Value, 'upload', _('Upload'),
			_('Maximum rate in Mbit/s. Use 0 for no limit.'));
		o.datatype = 'and(ufloat,min(0),max(1000))';
		o.rmempty = false;
		o.cfgvalue = rateCfgvalue;
		o.write = rateWrite;
		o.textvalue = rateText;

		o = gs.taboption('general', form.Value, 'connlimit', _('Connection limit'),
			_('Maximum number of simultaneous connections this client may hold, counted over the connections it opens in both directions. 0 means unlimited. Once the budget is reached only new connections are refused, running ones are kept. Costs no hardware queue, so it also works when both rates are 0. Needs kmod-nft-connlimit; 300-500 is a sane ceiling for one client, since the FOE table holds 16384 entries per direction and one device must not be able to fill it.'));
		o.modalonly = true;
		o.datatype = 'and(uinteger,min(0),max(65535))';
		o.default = '0';
		o.placeholder = '0';
		o.rmempty = false;
		o.write = integerWrite;

		o = gs.taboption('general', form.ListValue, 'selector', _('Type'));
		o.modalonly = true;
		o.default = 'ip';
		o.rmempty = false;
		o.value('ip', _('IPv4 address'));
		o.value('ip6', _('IPv6 address'));
		o.cfgvalue = function(section_id) { return selectorValue(section_id); };
		o.write = function(section_id, value) {
			uci.set('eqosex', section_id, 'selector', value);

			if (value !== 'ip')
				uci.unset('eqosex', section_id, 'ip');

			if (value !== 'ip6')
				uci.unset('eqosex', section_id, 'ip6');
		};

		o = gs.taboption('general', form.Value, 'ip', _('IPv4 address'));
		o.modalonly = true;
		o.datatype = 'ip4addr("nomask")';
		o.rmempty = false;
		o.depends('selector', 'ip');
		o.validate = addressValidate;
		o.description = _('Required. Enter an address manually or pick a device from the list.');
		addChoices(o, hostChoices.ip);

		o = gs.taboption('general', form.Value, 'ip6', _('IPv6 address'));
		o.modalonly = true;
		o.datatype = 'ip6addr("nomask")';
		o.rmempty = false;
		o.depends('selector', 'ip6');
		o.validate = addressValidate;
		o.description = _('Required. Enter an address manually or pick a device from the list.');
		addChoices(o, hostChoices.ip6);

		/* ---------------------------------------------------- tab: priority */
		s = m.section(form.TypedSection, '_priority', _('Packet priority settings'));
		s.anonymous = true;
		s.hidetitle = true;
		s.cfgsections = function() { return ['config']; };

		o = s.option(form.Flag, 'short_pkt_priority', _('Short-packet priority'),
			_('Recognizes short flows (TCP ACK / small UDP) in hardware before offload and puts them into the priority queue below. Tune it with "Short-flow length" and "Priority queue". Works on any port, including direct 2.5G.'));
		o.default = o.disabled;
		o.rmempty = false;

		o = s.option(form.Value, 'short_pkt_len', _('Short-flow length'),
			_('Maximum average packet size (16-128 bytes) treated as a short flow.'));
		o.depends('short_pkt_priority', '1');
		o.datatype = 'and(uinteger,min(16),max(128))';
		o.placeholder = '64';
		o.write = integerWrite;

		/* The queue is no longer configurable: the script pins short-packet
		   priority to the top hardware queue of the running SoC, so it can
		   never collide with the pool the device rules draw from.  A value
		   saved here would only be overwritten on the next start. */
		o = s.option(form.DummyValue, '_short_pkt_qid', _('Priority queue'),
			_('Automatic: the top hardware queue of this SoC (15 on the 16-queue MT7981/MT7986, 31 on the 32-queue MT7988). Kept outside the queue pool so short flows never share a queue with a shaped client.'));
		o.depends('short_pkt_priority', '1');

		o = s.option(form.SectionValue, '__rules__', form.GridSection, 'priority_rule',
			_('Priority rules'));
		gs = o.subsection;
		gs.addremove = true;
		gs.anonymous = true;
		gs.nodescriptions = true;
		gs.handleAdd = function(ev) {
			var section_id = uci.add('eqosex', 'priority_rule');
			m.addedSection = section_id;
			return this.renderMoreOptionsModal(section_id);
		};

		o = gs.option(form.Flag, 'enabled', _('Enable'));
		o.default = o.enabled;
		o.rmempty = false;
		o.editable = true;

		o = gs.option(form.ListValue, 'protocol', _('Protocol'));
		o.value('', _('Any'));
		o.value('tcp', 'TCP');
		o.value('udp', 'UDP');
		o.value('icmp', 'ICMP');
		o.default = '';
		/* Table cell shows the effective match: protocol Any with a port is
		   expanded to TCP + UDP rules by emit_priority_mark. */
		o.textvalue = function(section_id) {
			var proto = uci.get('eqosex', section_id, 'protocol');
			if (proto)
				return proto.toUpperCase();
			var port = uci.get('eqosex', section_id, 'sport') ||
				uci.get('eqosex', section_id, 'dport');
			return port ? 'TCP+UDP' : _('Any');
		};
		o.validate = function(section_id, value) {
			return validatePortProtocol.call(this, section_id, value, false);
		};

		o = gs.option(form.Value, 'sport', _('Source port'),
			_('Optional, e.g. 443 or 27000-27030.'));
		o.datatype = 'or(port,portrange)';
		o.rmempty = true;
		o.validate = function(section_id, value) {
			return validatePortProtocol.call(this, section_id, value, true);
		};

		o = gs.option(form.Value, 'dport', _('Dest port'),
			_('Optional, e.g. 53 or 27000-27030.'));
		o.datatype = 'or(port,portrange)';
		o.rmempty = true;
		o.validate = function(section_id, value) {
			return validatePortProtocol.call(this, section_id, value, true);
		};

		o = gs.option(form.Value, 'dscp', _('DSCP'),
			_('Optional DSCP value 0-63, e.g. 46 for EF.'));
		o.datatype = 'and(uinteger,min(0),max(63))';
		o.rmempty = true;

		o = gs.option(form.ListValue, 'direction', _('Direction'));
		o.value('up', _('Upload'));
		o.value('down', _('Download'));
		o.value('both', _('Both'));
		o.default = 'both';

		o = gs.option(form.ListValue, 'priority', _('Priority'),
			_('1 lowest .. 10 highest. Draws hardware queues from the same pool as the device rules, so enabling priority rules leaves fewer queues for per-client shaping. Custom rules take precedence over short-packet auto detection.'));
		for (var i = 1; i <= 10; i++)
			o.value(String(i), String(i));
		o.default = '5';
		o.rmempty = false;
		/* Must live on this ListValue: DummyValue widgets never run validators
		   (form.js renders them without a vfunc), so a check attached to the
		   queue-map display column is dead code. */
		o.validate = function(section_id, value) {
			var prio = Number(value);
			var dir = uci.get('eqosex', section_id, 'direction') || 'both';
			var qidUp = priorityQid(prio, 1);
			var qidDl = priorityQid(prio, 32);
			var i;

			var rules = uci.sections('eqosex', 'priority_rule');
			for (i = 0; i < rules.length; i++) {
				if (rules[i]['.name'] === section_id || rules[i].enabled === '0')
					continue;

				var p = Number(rules[i].priority || 5);
				var d = rules[i].direction || 'both';
				if ((dir === 'up' || dir === 'both') && (d === 'up' || d === 'both') &&
				    priorityQid(p, 1) === qidUp)
					return _('Upload queue %s is already used by another rule.').format(qidUp);
				if ((dir === 'down' || dir === 'both') && (d === 'down' || d === 'both') &&
				    priorityQid(p, 32) === qidDl)
					return _('Download queue %s is already used by another rule.').format(qidDl);
			}

			/* Short-packet priority and the device rules need no collision
			   check here any more: short-packet priority is pinned to the
			   top queue, outside the pool, and a device rule number no
			   longer maps to a queue -- the pool assigns those at start
			   time and the script reports exhaustion if it runs out. */

			return true;
		};

		o = gs.option(form.Flag, 'sp_redirect', _('Small packets to the short-packet priority queue'),
			_('Re-marks the small packets matched by this rule (pure TCP ACKs and packets up to the short-flow bound) into the short-packet priority queue, so ACKs do not queue behind bulk traffic inside this rule\'s queue. Requires Short-packet priority and a port.'));
		o.rmempty = true;
		/* Flag widgets DO run validators (ui.Checkbox receives the vfunc),
		   unlike DummyValue. */
		o.validate = function(section_id, value) {
			if (value !== '1')
				return true;
			if (uci.get('eqosex', 'config', 'short_pkt_priority') !== '1')
				return _('Enable Short-packet priority first.');
			return true;
		};

		o = gs.option(form.DummyValue, '_qidmap', _('Queue map'));
		o.textvalue = function(section_id) {
			var p = Number(uci.get('eqosex', section_id, 'priority') || 5);
			var d = uci.get('eqosex', section_id, 'direction') || 'both';
			var parts = [];
			if (d === 'up' || d === 'both')
				parts.push('%s: %s'.format(_('Upload'), priorityQid(p, 1)));
			if (d === 'down' || d === 'both')
				parts.push('%s: %s'.format(_('Download'), priorityQid(p, 32)));
			return parts.join(' / ');
		};

		/* ----------------------------------------------------- tab: monitor */
		s = m.section(form.TypedSection, '_monitor', _('Queue Monitor'));
		s.anonymous = true;
		s.hidetitle = true;
		s.cfgsections = function() { return ['_monitor']; };
		s.renderContents = function() {
			return Promise.resolve(form.TypedSection.prototype.renderContents.apply(this, arguments))
				.then(function(sectionEl) {
					sectionEl.appendChild(buildMonitor());
					return sectionEl;
				});
		};

		return m.render().then(function(nodes) {
			poll.add(async function() {
				let [sq, qs] = await Promise.all([
					L.resolveDefault(callShortPkt(), {}),
					L.resolveDefault(callQueueStats(), {})
				]);

				let infoEl = document.getElementById('eqosex-qmon-info');
				if (infoEl) {
					let parts = [
						'%s: %s'.format(_('Mode'), sq.qos || '-'),
						'%s: %s'.format(_('Len'), sq.len || '-'),
						'%s: %s'.format(_('Queue'), sq.qid || '-'),
						'%s: %s'.format(_('QoS'), sq.qos_toggle || '-'),
						'%s: %s'.format(_('Path'), sq.path || '-')
					];
					if (qs.pool && qs.pool.capacity)
						parts.push('%s: %s/%s'.format(_('Hardware queues'),
							qs.pool.used, qs.pool.capacity));
					L.dom.content(infoEl, E('span', {}, parts.join('  |  ')));
				}

				let warnEl = document.getElementById('eqosex-qmon-warn');
				if (warnEl) {
					L.dom.content(warnEl, null);
					if (qs.pool && qs.pool.full)
						L.dom.content(warnEl, E('em', {},
							_('The hardware queue pool is full: any further shaped client is limited in software (TC) instead, which keeps it shaped but takes it off hardware acceleration.')));
				}

				let body = document.getElementById('eqosex-qmon-body');
				if (!body)
					return;

				let activeOnly = true;
				let activeEl = document.getElementById('eqosex-qmon-active');
				if (activeEl)
					activeOnly = activeEl.checked;

				L.dom.content(body, null);
				let rows = [];
				for (let q in (qs.queues || {})) {
					let qq = qs.queues[q];
					if (activeOnly && !qq.packets && !qq.bytes && !qq.bps && !qq.pps)
						continue;
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', {}, q),
						E('td', {}, qs.has_counters && qq.bps ? '%s Mbit/s'.format((qq.bps / 1e6).toFixed(2)) : '-'),
						E('td', {}, qs.has_counters ? String(qq.pps || 0) : '-'),
						E('td', {}, qs.has_counters ? String(qq.packets || 0) : '-')
					]));
				}
				if (!rows.length)
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'colspan': 5 }, E('em', {}, _('No data')))
					]));
				L.dom.content(body, rows);
			});

			return nodes;
		});

		function buildMonitor() {
			let info = E('div', { 'id': 'eqosex-qmon-info' },
				E('em', {}, _('Collecting data...')));

			let warn = E('div', { 'id': 'eqosex-qmon-warn', 'class': 'cbi-value-description' });

			let toggle = E('label', { 'class': 'eqosex-qmon-toggle' },
				[ E('input', { 'type': 'checkbox', 'id': 'eqosex-qmon-active', 'checked': true }),
				  ' ', _('Active queues only') ]);

			let table = E('table', { 'class': 'table eqosex-qmon-table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'left' }, _('Queue')),
					E('th', { 'class': 'left' }, _('Rate')),
					E('th', { 'class': 'left' }, _('Packets/s')),
					E('th', { 'class': 'left' }, _('Packets'))
				]),
				E('tbody', { 'id': 'eqosex-qmon-body' })
			]);

			return E('div', {}, [
				E('style', {}, '.eqosex-qmon-table th,.eqosex-qmon-table td{padding:1px 8px;font-size:12px;line-height:1.35}'),
				info,
				warn,
				toggle,
				table
			]);
		}
	}
});

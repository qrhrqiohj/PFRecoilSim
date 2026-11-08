--[[
	RecoilSim – Studio exporter
	===========================
	Re-exports every gun, attachment and attachment set from the open place and
	sends it to a running RecoilSim (python run.py) on this computer.

	How to use:
	  1. Start RecoilSim on this PC (double-click RecoilSim.bat or run `python run.py`).
	  2. Open your place in Roblox Studio (Edit mode is fine, no need to press Play).
	  3. Paste this whole file into the Command Bar (View > Command Bar) and press Enter.
	  4. Watch the Output window. When it says "RecoilSim import complete", refresh the
	     browser tab and the new stats are live.

	The script only READS your place. It temporarily enables HttpService.HttpEnabled so
	it can talk to localhost and restores the previous value afterwards.
]]

local PORT = 8765 -- change if RecoilSim printed a different port
local CHUNK = 900000

local HttpService = game:GetService("HttpService")
local RF = game:GetService("ReplicatedFirst")
local Content = game:GetService("ReplicatedStorage"):WaitForChild("Content")
local PC = Content:WaitForChild("ProductionContent")

-- ------------------------------------------------------------------ module loader
-- Weapon/attachment modules have extra script capabilities, so require() from the
-- command bar is refused. Load their source with loadstring instead.
local cache = {}
local moduleIndex = {}
for _, d in RF:GetDescendants() do
	if d:IsA("ModuleScript") and not moduleIndex[d.Name] then
		moduleIndex[d.Name] = d
	end
end
local loadModule
local baseEnv = getfenv(1)
local function makeEnv(inst)
	local sh = setmetatable({
		require = function(name)
			local m = moduleIndex[name]
			if not m then error("no module " .. tostring(name)) end
			return loadModule(m)
		end,
	}, { __index = shared })
	return setmetatable({
		script = inst,
		shared = sh,
		require = function(m)
			if typeof(m) == "Instance" then return loadModule(m) end
			return require(m)
		end,
	}, { __index = baseEnv })
end
function loadModule(inst)
	if cache[inst] ~= nil then return cache[inst] end
	local f, err = loadstring(inst.Source, inst.Name)
	if not f then error("compile " .. inst:GetFullName() .. ": " .. tostring(err)) end
	setfenv(f, makeEnv(inst))
	local r = f()
	cache[inst] = r
	return r
end

-- ------------------------------------------------------------------ serialiser
local SKIP = { animations = true, animationmods = true }
local function ser(v, depth)
	depth = depth or 0
	local t = typeof(v)
	if t == "number" then
		if v ~= v then return nil end
		if v == math.huge then return 1e300 elseif v == -math.huge then return -1e300 end
		return v
	elseif t == "string" or t == "boolean" then
		return v
	elseif t == "Vector3" then
		return { __v3 = { v.X, v.Y, v.Z } }
	elseif t == "Vector2" then
		return { __v2 = { v.X, v.Y } }
	elseif t == "CFrame" then
		local c = { v:GetComponents() }
		for i = 1, 12 do c[i] = math.round(c[i] * 1e5) / 1e5 end
		return { __cf = c }
	elseif t == "Color3" then
		return { __c3 = { v.R, v.G, v.B } }
	elseif t == "function" then
		return { __func = true }
	elseif t == "table" then
		if depth > 40 then return "__deep" end
		local n = #v
		local count = 0
		for _ in pairs(v) do count += 1 end
		if count == n then
			if n == 0 then return { __empty = true } end
			local arr = {}
			for i = 1, n do
				local s = ser(v[i], depth + 1)
				if s == nil then s = "__nil" end
				arr[i] = s
			end
			return arr
		end
		local obj = {}
		for k, val in pairs(v) do
			local key = type(k) == "number" and ("#" .. tostring(k)) or tostring(k)
			if not (depth == 0 and SKIP[key]) then
				local s = ser(val, depth + 1)
				if s ~= nil then obj[key] = s end
			end
		end
		return obj
	end
	return "__" .. t
end

local FIELD_SKIP = { attachmentModifiers = true, info = true }
local function fieldsOf(tbl)
	local out = {}
	for k, v in pairs(tbl) do
		if type(k) == "string" and not FIELD_SKIP[k] then
			local sv = ser(v, 1)
			if sv ~= nil then out[k] = sv end
		end
	end
	return out
end

local function animTimes(anims)
	local out = {}
	if type(anims) ~= "table" then return out end
	for name, a in pairs(anims) do
		if type(a) == "table" then
			local ds = 0
			for _, step in next, a do
				if type(step) == "table" and step.delay then ds += step.delay end
			end
			out[name] = { ts = a.timescale or 0.5, rt = a.resettime or 0.5, ds = ds }
		end
	end
	return out
end

-- ------------------------------------------------------------------ export
print("[RecoilSim] Exporting…")
local SetFunctions = loadModule(moduleIndex.SetFunctions)
local LuaUtils = loadModule(moduleIndex.LuaUtils)

local setModules = {}
local function collectSets(root)
	local db = root:FindFirstChild("AttachmentDatabase")
	local sets = db and db:FindFirstChild("Sets")
	if not sets then return end
	for _, folder in sets:GetChildren() do
		for _, m in folder:GetChildren() do
			if m:IsA("ModuleScript") and not setModules[m.Name] then setModules[m.Name] = m end
		end
	end
end
collectSets(PC)
local TC = Content:FindFirstChild("TestContent")
if TC then collectSets(TC) end

local attachments, attCount = {}, 0
for _, cat in PC.AttachmentDatabase.Categories:GetChildren() do
	for _, af in cat:GetChildren() do
		local m = af:FindFirstChild("AttachmentData")
		if m and m:IsA("ModuleScript") then
			local ok, d = pcall(loadModule, m)
			if ok and type(d) == "table" then
				attachments[af.Name] = { category = cat.Name, displayname = d.displayname, info = d.info, mods = ser(d.attachmentModifiers or {}, 1), fields = fieldsOf(d) }
				attCount += 1
			else
				warn("[RecoilSim] attachment failed:", af.Name, d)
			end
		end
	end
end

local SLOTS = { "Optics", "Barrel", "Underbarrel", "Other", "Ammo" }
local weapons, wCount = {}, 0
for _, classFolder in PC.WeaponDatabase:GetChildren() do
	for _, wf in classFolder:GetChildren() do
		local m = wf:FindFirstChild(wf.Name)
		if m and m:IsA("ModuleScript") then
			local ok, d = pcall(loadModule, m)
			if ok and type(d) == "table" and d.recoil and d.damageGraph then
				local ok2, res = pcall(function()
					local base = LuaUtils.deepCopy(d)
					local attSet = {}
					if d.attachmentModifiers and d.attachmentSetOrder then
						local sets = {}
						for _, sn in d.attachmentSetOrder do
							local sm = setModules[sn]
							table.insert(sets, sm and loadModule(sm) or { {} })
						end
						local so = SetFunctions.new(sets)
						for _, op in d.attachmentModifiers do so[op[1]](so, unpack(op, 2)) end
						for _, slot in SLOTS do
							attSet[slot] = {}
							for an, entry in pairs(so[slot] or {}) do
								attSet[slot][an] = { mods = ser(entry.attachmentModifiers or {}, 1), displayname = entry.displayname, fields = fieldsOf(entry) }
							end
						end
					end
					base.attachmentModifiers = nil
					base.attachmentSetOrder = nil
					return { class = classFolder.Name, data = ser(base, 0), attachments = attSet, anims = animTimes(d.animations) }
				end)
				if ok2 then
					weapons[wf.Name] = res
					wCount += 1
				else
					warn("[RecoilSim] weapon failed:", wf.Name, res)
				end
			elseif not ok then
				warn("[RecoilSim] weapon failed:", wf.Name, d)
			end
		end
	end
end

-- ------------------------------------------------------------------ 3D models
-- Part layouts of every gun and attachment model (positions, sizes, colours,
-- shapes). Mesh shapes are only readable for meshes your account is allowed to
-- edit; for those the real triangles are exported too, otherwise the viewer
-- draws each mesh part as its bounding box.
print("[RecoilSim] Exporting 3D models…")
local AssetService = game:GetService("AssetService")
local TRY_REAL_MESHES = true
local meshes, meshDenied, meshTried = {}, 0, 0
local function r4(x) return math.round(x * 1e4) / 1e4 end
local function exportMesh(mp)
	if not TRY_REAL_MESHES or meshes[mp.MeshId] ~= nil then return end
	meshTried += 1
	local ok, em = pcall(function()
		return AssetService:CreateEditableMeshAsync(Content.fromUri(mp.MeshId))
	end)
	if not ok then
		meshes[mp.MeshId] = false
		meshDenied += 1
		if meshDenied >= 8 and meshDenied == meshTried then
			TRY_REAL_MESHES = false
			print("[RecoilSim] Mesh shapes aren't readable with this account, using part boxes instead")
		end
		return
	end
	local verts, faces, index = {}, {}, {}
	for _, vid in em:GetVertices() do
		local p = em:GetPosition(vid)
		index[vid] = #verts / 3
		table.insert(verts, r4(p.X)); table.insert(verts, r4(p.Y)); table.insert(verts, r4(p.Z))
	end
	for _, fid in em:GetFaces() do
		local fv = em:GetFaceVertices(fid)
		if #fv == 3 then
			table.insert(faces, index[fv[1]]); table.insert(faces, index[fv[2]]); table.insert(faces, index[fv[3]])
		end
	end
	local size = mp.MeshSize
	meshes[mp.MeshId] = { v = verts, f = faces, size = { r4(size.X), r4(size.Y), r4(size.Z) } }
	em:Destroy()
end
local KIND = { Part = "P", MeshPart = "M", UnionOperation = "U", WedgePart = "W", CornerWedgePart = "C", TrussPart = "T" }
local function serPart(p)
	local c = { p.CFrame:GetComponents() }
	for i = 1, 12 do c[i] = r4(c[i]) end
	local col = p.Color
	local rec = {
		n = p.Name,
		k = KIND[p.ClassName] or "P",
		cf = c,
		s = { r4(p.Size.X), r4(p.Size.Y), r4(p.Size.Z) },
		c = string.format("%02x%02x%02x", math.round(col.R * 255), math.round(col.G * 255), math.round(col.B * 255)),
		m = p.Material.Name,
	}
	if p.Transparency > 0 then rec.t = r4(p.Transparency) end
	if p:IsA("Part") then rec.sh = p.Shape.Name end
	if p:IsA("MeshPart") then
		rec.mid = p.MeshId
		exportMesh(p)
	end
	local sm = p:FindFirstChildOfClass("SpecialMesh")
	if sm then rec.sm = { t = sm.MeshType.Name, s = { r4(sm.Scale.X), r4(sm.Scale.Y), r4(sm.Scale.Z) }, o = { r4(sm.Offset.X), r4(sm.Offset.Y), r4(sm.Offset.Z) } } end
	local bm = p:FindFirstChildOfClass("BlockMesh") or p:FindFirstChildOfClass("CylinderMesh")
	if bm then rec.bm = { t = bm.ClassName, s = { r4(bm.Scale.X), r4(bm.Scale.Y), r4(bm.Scale.Z) } } end
	return rec
end
local function serModel(model, skip)
	local parts = {}
	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") and not (skip and d:IsDescendantOf(skip)) then
			table.insert(parts, serPart(d))
		end
	end
	return parts
end

local weaponModels = {}
for _, classFolder in PC.WeaponDatabase:GetChildren() do
	for _, wf in classFolder:GetChildren() do
		local main = wf:FindFirstChild(wf.Name .. " Main")
		if main and weapons[wf.Name] then
			local nodesFolder = main:FindFirstChild("MenuNodes")
			local nodes = {}
			if nodesFolder then
				for _, n in nodesFolder:GetDescendants() do
					if n:IsA("BasePart") then nodes[n.Name] = serPart(n) end
				end
			end
			weaponModels[wf.Name] = { parts = serModel(main, nodesFolder), nodes = nodes }
		end
	end
	task.wait()
end

local attachmentModels = {}
for _, cat in PC.AttachmentDatabase.Categories:GetChildren() do
	for _, af in cat:GetChildren() do
		local folder = af:FindFirstChild("Models")
		if folder then
			local models = {}
			for _, m in folder:GetChildren() do
				models[m.Name] = serModel(m)
			end
			attachmentModels[af.Name] = models
		end
	end
	task.wait()
end
local sharedModels = {}
local shared = PC.AttachmentDatabase:FindFirstChild("SharedModels")
if shared then
	for _, d in shared:GetDescendants() do
		if d:IsA("Model") then
			local par = d.Parent
			while par ~= shared and par:IsA("Folder") do par = par.Parent end
			if par == shared then sharedModels[d.Name] = serModel(d) end
		end
	end
end
local meshCount = 0
for _, m in meshes do if m then meshCount += 1 end end
print(string.format("[RecoilSim] models: %d guns, %d attachments, %d real meshes", (function() local n = 0 for _ in weaponModels do n += 1 end return n end)(), (function() local n = 0 for _ in attachmentModels do n += 1 end return n end)(), meshCount))
local realMeshes = {}
for id, m in meshes do if m then realMeshes[id] = m end end

local json = HttpService:JSONEncode({
	models = { weapons = weaponModels, attachments = attachmentModels, shared = sharedModels, meshes = realMeshes },
	version = 1,
	exportedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"),
	source = game.Name,
	weapons = weapons,
	attachments = attachments,
})
print(string.format("[RecoilSim] %d guns, %d attachments, %.1f MB – sending to localhost:%d", wCount, attCount, #json / 1e6, PORT))

-- ------------------------------------------------------------------ send
local wasEnabled = HttpService.HttpEnabled
pcall(function() HttpService.HttpEnabled = true end)
local id = HttpService:GenerateGUID(false)
local total = math.ceil(#json / CHUNK)
local okAll = true
for part = 1, total do
	local body = string.sub(json, (part - 1) * CHUNK + 1, part * CHUNK)
	local ok, resp = pcall(function()
		return HttpService:RequestAsync({
			Url = string.format("http://127.0.0.1:%d/api/import?part=%d&total=%d&id=%s", PORT, part, total, id),
			Method = "POST",
			Headers = { ["Content-Type"] = "text/plain" },
			Body = body,
		})
	end)
	if not ok or not resp.Success then
		okAll = false
		warn("[RecoilSim] upload failed on part", part, ok and resp.StatusCode or resp)
		warn("[RecoilSim] Is RecoilSim running? Check the port it printed and that Studio may make HTTP requests.")
		break
	end
end
pcall(function() HttpService.HttpEnabled = wasEnabled end)
if okAll then
	print("[RecoilSim] import complete – refresh the RecoilSim browser tab")
end

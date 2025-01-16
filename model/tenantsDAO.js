
const ObjectId = require('mongodb').ObjectId;
const mongo = require('../database/mongo');

module.exports = {
    addTenant: async (tenant) => {
        return await mongo.Tenants.insertOne(tenant);
    },
    diskLimitreaching: async(id)=>{
        var tenant = await mongo.Tenants.findOne({_id:new ObjectId(id)});
        if (tenant.allowedDiskSpace-tenant.usedDiskSpace<=5) {
            return {isLimitreaching:true};
        }
        else{
            return {isLimitreaching:false};
        }
    },
    getAllTenants: async () => {
        return await mongo.Tenants.find({isDeleted:false}).limit(50).sort({"_id": -1}).toArray();
    },
    getTenantById: async (id) => {
        return await mongo.Tenants.findOne({ _id: new ObjectId(id) }, {files: 0});
    },
    getTenantByCompanyIdentifier: async (companyIdentifier) => {
        return await mongo.Tenants.findOne({ companyIdentifier: companyIdentifier }, {files: 0});
    },
    addTenantDiskSpace: async (id, space) => {
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id) }, { $set: { "allowedDiskSpace": space }});
    },

    addTenantUsedDiskSpace: async (id, space) => {
        console.log("Image size:", space);
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id) }, { $inc: { 
        "usedDiskSpace": +space }});
    },

    increaseTenantValidity: async (id, days) => {
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id) }, { $inc: { validity: +days }});
    },
    increaseTenantUsers: async (id, count) => {
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id) }, { $set: { allowedUsersCount: count }});
    },
    increaseAllowedCustomForms: async (id, count) => {
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id) }, { $set: { allowedCustomFormCount: count }});
    },
    addCustomFormCount: async (id) => {
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id) }, { $inc: { customFormCount: 1 }});
    },
    updateStorageStats:async (identifier,count,size)=>{
        return await mongo.Tenants.updateOne({companyIdentifier:identifier},{$inc:{imageCount:+count,usedDiskSpace:+size}})
    },
    editTenant: async (id, newData) => {
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id) }, { $set: newData },{upsert:false});
    },

    toggleTenantAccess: async (id, isActive) => {
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id) }, { $set: { isActive: isActive } });
    },

    toggleShowFooterlogo: async (id, value) => {
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id) }, { $set: { showFooterlogo: value } });
    },

    deleteTenantPermanently: async (id) => {
        var tenant = await mongo.Tenants.findOne({ _id: new ObjectId(id) });
        try {
            await mongo.Users.deleteMany({ companyIdentifier: tenant.companyIdentifier });
        } catch (error) {
            console.log(error);
        }
        return await mongo.Tenants.deleteOne({ _id: new ObjectId(id) });
    }, 
    deleteTenant: async (id) => {
        var tenant = await mongo.Tenants.findOne({ _id: new ObjectId(id) });
        try {
            await mongo.Users.deleteMany({ companyIdentifier: tenant.companyIdentifier });
        } catch (error) {
            console.log(error);
        }
        
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id) }, { $set: { isDeleted: true }});
    },    
    
    updateAddIconsForTenant:async (id,iconsData)=>{
        try {
            return await mongo.Tenants.updateOne({ _id: new ObjectId(id)},{$set:{icons:iconsData}});
        } catch (error) {
            console.log(error);
        }
        
    },

    updateAdminDetails:async (id,adminDetails)=>{
        try {
            return await mongo.Tenants.updateOne({ _id: new ObjectId(id)},{$push:{adminDetails:adminDetails}});
        } catch (error) {
            console.log(error);
        }
        
    },
    
    updateTenantLogo:async (id,logoURL)=>{
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id)},{$set:{"icons.logoUrl":logoURL}});
    },
    updateEndDate:async (id,endDate)=>{
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id)},{$set:{endDate:endDate}});
    },
    updateTenantWebsite:async (id,website)=>{
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id)},{$set:{website:website}});
    },
    updateTenantsAzureStorageDataDetails:async(id,azureStorageDetails)=>{
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id)},{$set:{azureStorageDetails:azureStorageDetails}});
    },
    updateTenantExpenses: async (id, expense) => {
        return await mongo.Tenants.updateOne({ _id: new ObjectId(id) }, { $set: { expenses: expense }});
    },
    isTenantActive : async (identifier)=>{
        return mongo.Tenants.findOne({ companyIdentifier: identifier });
    }
};

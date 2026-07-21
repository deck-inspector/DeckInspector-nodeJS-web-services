"use strict";
var express = require("express");
var router = express.Router();

const ErrorResponse = require("../model/error");
var ObjectId = require("mongodb").ObjectId;
const newErrorResponse = require("../model/newError");
const TenantService = require("../service/tenantService");
const users = require("../model/user");
const tenantsDAO = require("../model/tenantsDAO");
const BlobManager = require("../database/uploadimage");
const bcrypt = require("bcrypt");
var jwt = require("jsonwebtoken");
const { endsWith } = require("lodash");

require("dotenv").config();

router.route("/add").post(async function (req, res) {
  try {
    var errResponse;
    // Get user input
    var {
      name,
      companyDescription,
      website,
      allowedDiskSpace,
      mobileUserCount,
      webUserCount,
      bothUserCount,
      endDate,
      footerText,
      allowedCustomFormCount,
      showFooterlogo,
    } = req.body;

    // Validate user input
    if (name === undefined) {
      errResponse = new ErrorResponse(
        400,
        "Name is required",
        "Mandatory field is missing"
      );
      res.status(400).json(errResponse);
      return;
    }
    var registrationDate = new Date(Date.now()).toISOString();
    //var endDate = registrationDate.setDate(registrationDate.getDate()+10) ;
    var newTenant = {
      name: name,
      registrationDate: registrationDate,
      companyDescription: companyDescription,
      website: website,
      endDate: endDate,
      allowedDiskSpace: allowedDiskSpace === undefined ? 10 : allowedDiskSpace,
      allowedCustomFormCount:allowedCustomFormCount===undefined?0:allowedCustomFormCount,
      mobileUserCount: mobileUserCount === undefined ? 0 : mobileUserCount,
      webUserCount: webUserCount === undefined ? 0 : webUserCount,
      bothUserCount: bothUserCount === undefined ? 0 : bothUserCount,
      customFormCount :0,
      isActive: true,
      isDeleted: false,
      usedDiskSpace: 0,
      reportCount: 0,
      imageCount: 0,
      companyIdentifier: `${name.toLowerCase()}.ondeckinspectors.com`,
      footerText: footerText || "",
      showFooterlogo: showFooterlogo || false, 
    };

    const companyName = await tenantsDAO.getTenantByCompanyIdentifier(
      newTenant.companyIdentifier
    );

    if (companyName) {
      return res
        .status(400)
        .json(
          new newErrorResponse(400, false, "Company name is already in use")
        );
    }

    var result = await TenantService.addTenant(newTenant);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      //console.debug(result);
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception.message);
    return res.status(500).json(errResponse);
  }
});

router.route("/alltenants").get(async function (req, res) {
  try {
    var errResponse;
    var result = await TenantService.getAllTenants();
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      //console.debug(result);
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router.route("/identifier/:companyIdentifier").get(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    var result = await TenantService.getTenantByCompanyIdentifier(
      req.params.companyIdentifier
    );
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      //console.debug(result);
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router.route("/:id").get(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    var result = await TenantService.getTenantById(tenantId);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      //console.debug(result);
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router
  .route("/:id")
  .put(async function (req, res) {
    try {
      var errResponse;
      const updateData = req.body;
      const tenantId = req.params.id;
      if (updateData.name === undefined) {
        errResponse = new ErrorResponse(
          400,
          "Name is required",
          "Mandatory field is missing"
        );
        res.status(400).json(errResponse);
        return;
      }
      var newTenant = {
        name: updateData.name,
        companyDescription: updateData.companyDescription,
        mobileUserCount: updateData.mobileUserCount,
        webUserCount: updateData.webUserCount,
        bothUserCount: updateData.bothUserCount,
        footerText: updateData.footerText
      };

      var result = await TenantService.editTenant(tenantId, newTenant);
      if (result.reason) {
        return res.status(result.code).json(result);
      }
      if (result) {
        //console.debug(result);
        return res.status(201).json(result);
      }
    } catch (exception) {
      errResponse = new newErrorResponse(500, false, exception);
      return res.status(500).json(errResponse);
    }
  })
  .delete(async function (req, res) {
    try {
      var errResponse;
      const tenantId = req.params.id;
      var result = await TenantService.deleteTenant(tenantId);
      if (result.reason) {
        return res.status(result.code).json(result);
      }
      if (result) {
        //console.debug(result);
        return res.status(201).json(result);
      }
    } catch (exception) {
      errResponse = new newErrorResponse(500, false, exception);
      return res.status(500).json(errResponse);
    }
  });
// router.route('/:id/getusagedetails')
// .get(async function (req,res) {
//   try {
//     var errResponse;
//     const tenantId = req.params.id;

//     var result = await TenantService.getTenantById(tenantId);
//     if (result.reason) {
//       return res.status(result.code).json(result);
//     }

//   }
//   catch (exception) {
//     errResponse = new newErrorResponse(500, false, exception);
//     return res.status(500).json(errResponse);
//   }
// });
router.route("/:id/toggletenantstatus/:state").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const state = req.params.state;
    const isActive = state == 1 ? true : false;
    var result = await TenantService.toggleAccessForTenant(tenantId, isActive);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router.route("/:id/toggleShowFooterLogoStatus/:state").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const state = req.params.state;
    const value = state == 1 ? true : false;
    var result = await TenantService.toggleShowFooterLogo(tenantId, value);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router.route("/:id/updatevaliditydate").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    var { endDate } = req.body;
    //var formattedendDate = new Date(endDate).toISOString();

    var result = await TenantService.updateValidityDate(tenantId, endDate);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router.route("/:id/adddiskspace/:diskspace").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const diskspace = req.params.diskspace;

    var result = await TenantService.addDiskSpace(tenantId, diskspace);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

// router.route('/:id/increaseValidity/:validity')
// .post(async function (req, res) {
//   try {
//     var errResponse;
//     const tenantId = req.params.id;
//     const validity = req.params.validity;

//     var result = await TenantService.increaseTenantValidity(tenantId, validity);
//     if (result.reason) {
//       return res.status(result.code).json(result);
//     }
//     if (result) {
//       return res.status(201).json(result);
//     }
//   }
//   catch (exception) {
//     errResponse = new newErrorResponse(500, false, exception);
//     return res.status(500).json(errResponse);
//   }
// });

router.route("/:id/increasetenantusers/:count").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const count = parseInt(req.params.count);

    var result = await TenantService.increaseTenantUsers(tenantId, count);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});
router.route("/:id/increasecustomformcount/:count").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const count = parseInt( req.params.count);

    var result = await TenantService.increaseAllowedCustomForms(tenantId, count);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});
router.route("/:id/upserticons").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const iconsData = req.body;

    var result = await TenantService.updateAddIconsForTenant(
      tenantId,
      iconsData
    );
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router.route("/:id/updatestoragedatadetails/").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const azureStorageDetails = req.body;

    var result = await TenantService.updateTenantsAzureStorageDataDetails(
      tenantId,
      azureStorageDetails
    );
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception.message);
    return res.status(500).json(errResponse);
  }
});

router.route("/:id/updatelogo").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const { url } = req.body;

    var result = await TenantService.updateLogoURL(tenantId, url);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router.route("/:id/updatewebsite").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const { website } = req.body;

    var result = await TenantService.updateTenantWebsite(tenantId, website);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

// Contact phone number shown on generated reports (Admin panel field).
router.route("/:id/updatephone").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const { phone } = req.body;

    var result = await TenantService.updateTenantPhone(tenantId, phone);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router.route("/:id/updateexpenses").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const { expense } = req.body;

    var result = await TenantService.updateTenantExpenses(tenantId, expense);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router.route("/:id/addusedspace").post(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;
    const { space } = req.body;

    var result = await TenantService.addUsedDiskSpace(tenantId, space);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router.route("/:id/diskwarning").get(async function (req, res) {
  try {
    var errResponse;
    const tenantId = req.params.id;

    var result = await TenantService.getDiskWarning(tenantId);
    if (result.reason) {
      return res.status(result.code).json(result);
    }
    if (result) {
      return res.status(201).json(result);
    }
  } catch (exception) {
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});

router.route("/:id/registerAdmin").post(async function (req, res) {
  try {
    // console.log("tenant-endpoint");
    var errResponse;
    const tenantId = req.params.id;
    const { first_name, last_name, username, email, mobile, companyIdentifier } =
      req.body;

    const { password, ...adminDetails } = req.body;
    var appSecret = process.env.APP_SECRET;
    //create admin in users collection
    users.registerAdmin(
      first_name,
      last_name,
      username,
      email,
      mobile,
      password,
      appSecret,
      companyIdentifier,
      function (err, result) {
        if (err) {
          res.status(err.status).send(err.message);
        } else {
          const user = result;
          // Create token
          const token = jwt.sign(
            { user_id: user._id, email, company: companyIdentifier },
            process.env.TOKEN_KEY,
            {
              expiresIn: "30d",
            }
          );
          // save user token
          user.token = token;

          TenantService.addUpdateAdmin(tenantId, req.body)
            .then((result) => {
              if (result.reason) {
                return res.status(result.code).json(result);
              }
              if (result) {
                return res.status(201).json(result);
              }
            })
            .catch((error) => {
              console.log(error);
              errResponse = new newErrorResponse(500, false, error);
              return res.status(500).json(errResponse);
            });
        }
      }
    );
  } catch (exception) {
    console.log(exception);
    errResponse = new newErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
});



// router.route('/addSuperUser')
// .post(async function(req,res){
//   try {
//     var errResponse;
//     const {first_name, last_name,username, email, password} = req.body;
//     //create admin in users collection
//     users.addSuperUser({first_name, last_name,username, email, password}, function (err, result){
//       if (err) { res.status(err.status).send(err.message); }
//       else {
//           const user = result;
//               // Create token
//               const token = jwt.sign(
//               { user_id: user._id, email},
//               process.env.TOKEN_KEY,
//               {
//               expiresIn: "30d",
//               });
//               // save user token
//               user.token = token;

//               // return new user
//               res.status(201).json(user);
//       }

//   });
//   }
//   catch (exception) {
//     errResponse = new newErrorResponse(500, false, exception);
//     return res.status(500).json(errResponse);
//   }
// });

//#region Login

//#endregion
module.exports = router;

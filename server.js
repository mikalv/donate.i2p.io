const http = require('http'),
    paypal = require('paypal-rest-sdk'),
    bodyParser = require('body-parser'),
    express = require('express'),
    logger = require('morgan'),
    path = require('path'),
    fs = require('fs'),
    app = require('express')()

const environment = process.env.ENV || 'development'
const config = require(`./config/${environment}.js`)

const stripe = require('stripe')(config.stripe.sk),
      moment = require('moment'),
      _ = require('lodash')

app.enable('trust proxy')
app.use(bodyParser.json())
app.use(logger())

const index_content = fs.readFileSync(path.join(__dirname, 'public', 'index.html')).toString()
const iban_content = fs.readFileSync(path.join(__dirname, 'public', 'iban.html')).toString()
const crypto_content = fs.readFileSync(path.join(__dirname, 'public', 'crypto.html')).toString()


paypal.configure({
  'mode': config.paypal.mode, //sandbox or live
  'client_id': config.paypal.client_id,
  'client_secret': config.paypal.secret
})

var static_file_options = {
  dotfiles: 'ignore',
  etag: false,
  extensions: ['htm', 'html', 'js', 'css', 'png', 'ttf', 'woff'],
  index: false,
  maxAge: '1d',
  redirect: false,
  setHeaders: function (res, path, stat) {
    res.set('x-timestamp', Date.now())
  }
}

function create_recurring(usd_size,req,res) {
  //Atrributs for creating the billing plan of  a user.
  let billingPlanAttributes = {
    "description": "Monthly donation to I2P.",
    "merchant_preferences": {
      "auto_bill_amount": "yes",
      "cancel_url": `${config.base_url}/paypal/cancel`,
      "initial_fail_amount_action": "continue",
      "max_fail_attempts": "1",
      "return_url": `${config.base_url}/paypal/process`,
      "setup_fee": {
        "currency": "USD",
        "value": "0"
      }
    },
    "name": "Monthly donation to I2P",
    "payment_definitions": [
      {
        "amount": {
          "currency": "USD",
          "value": usd_size
        },
        "charge_models": [],
        "cycles": "0",
        "frequency": "MONTH",
        "frequency_interval": 1,
        "name": "Monthly donation to I2P",
        "type": "REGULAR"
      }
    ],
    "type": "INFINITE"
  }

  //Once a billing plan is created it must be updated with the following attributes.
  let billingPlanUpdateAttributes = [
    {
      "op": "replace",
      "path": "/",
      "value": {
        "state": "ACTIVE"
      }
    }
  ]

  let startDate = moment(new Date()).add(10, 'minute').format('gggg-MM-DDTHH:mm:ss')+'Z';
  let billingAgreementAttributes = {
    "name": "Monthly donation to I2P",
    "description": `This agreement will donate ${usd_size} USD on a monthly basis.`,
    "start_date": startDate,
    "plan": {
      "id": ""
    },
    "payer": {
      "payment_method": "paypal"
    }
  }
  paypal.billingPlan.create(billingPlanAttributes,  (error, billingPlan) => {
    if (error) {
      console.log(error);
    } else {
      //Step 7:
      paypal.billingPlan.update(billingPlan.id, billingPlanUpdateAttributes,  (error, response) => {
        if (error) {
          console.log(error)
        } else {
          // update the billing agreement attributes before creating it.
          billingAgreementAttributes.plan.id = billingPlan.id;

          //Step 8:
          paypal.billingAgreement.create(billingAgreementAttributes,(error, billingAgreement) => {
            if (error) {
              console.log(error)
            } else {
              _.forEach(billingAgreement.links, (agreement) => {
                if (agreement.rel === 'approval_url') {
                  //Redirecting to paypal portal with approvalUrl.
                  let approvalUrl = agreement.href
                  let token = approvalUrl.split('token=')[1]
                  console.log(approvalUrl,token)
                  res.redirect(approvalUrl)
                }
              })
            }
          }) // else
        }
      })
    }
  })
}

app.use(express.static('public', static_file_options))

app.get('/', function(req, res){
  //console.log(req)
  res.send(index_content)
})
app.get('/iban', function(req, res){
  res.send(iban_content)
})
app.get('/crypto', function(req, res){
  res.send(crypto_content)
})

app.get('/paypal/create_donation_agreement/:size', function(req, res){
  let pay_size = parseFloat(req.params['size']) || 5
  return create_recurring(pay_size,req,res)
})

app.get('/paypal/create_donation/:size', function(req, res){
  let pay_size = parseFloat(req.params['size']) || 5
  //build PayPal payment request
  var payReq = JSON.stringify({
    'intent':'sale',
    'redirect_urls':{
      'return_url':`${config.base_url}/paypal/process`,
      'cancel_url':`${config.base_url}/paypal/cancel`
    },
    'payer':{
      'payment_method':'paypal'
    },
    'transactions':[{
      'amount':{
        'total': pay_size,
        'currency':'USD'
      },
      'description':'Donation to I2P.'
    }]
  })

  paypal.payment.create(payReq, function(error, payment){
    if(error){
      console.error(error)
    } else {
      //capture HATEOAS links
      var links = {};
      payment.links.forEach(function(linkObj){
        links[linkObj.rel] = {
          'href': linkObj.href,
          'method': linkObj.method
        }
      })

      //if redirect url present, redirect user
      if (links.hasOwnProperty('approval_url')){
        res.redirect(links['approval_url'].href)
      } else {
        console.error('no redirect URI present')
      }
    }
  })
})

app.get('/paypal/process', function(req, res){
  var paymentId = req.query.paymentId
  var token = req.query.token

  if (paymentId) {
    paypal.payment.execute(paymentId, payerId, function(error, payment){
      if(error){
        console.error(error);
      } else {
        if (payment.state == 'approved'){
          res.redirect('/')
          //res.send('payment completed successfully')
        } else {
          res.send('payment/donation failed :(')
        }
      }
    })
  }
  if (token) {
    paypal.billingAgreement.execute(token, {}, function (error, billingAgreement) {
      if (error) {
        console.error(error)
        throw error
      } else {
        console.log(JSON.stringify(billingAgreement))
        res.redirect('/')
      }
    })
  }
})

http.createServer(app).listen(config.listen_port, function () {
  console.log(`Server started: Listening on port ${config.listen_port}`)
})


